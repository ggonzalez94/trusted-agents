import {
	type CreateTapRuntimeOptions,
	type TapRuntime,
	createTapRuntime,
} from "@trustedagents/sdk";
import {
	SchedulingHandler,
	type TapServiceHooks,
	type TapTransferApprovalContext,
	type TrustedAgentsConfig,
	executeOnchainTransfer,
	summarizeGrant,
} from "trusted-agents-core";
import type { ProposedMeeting, SchedulingApprovalContext } from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { resolveConfiguredCalendarProvider } from "./calendar/setup.js";
import { info } from "./output.js";
import { promptYesNo } from "./prompt.js";
import { getCliRuntimeOverride } from "./runtime-overrides.js";
import { createConfiguredSigningProvider } from "./wallet-config.js";

/** Hooks that CLI commands can pass through to the runtime. */
export interface CliTapServiceHooks {
	approveTransfer?: (context: TapTransferApprovalContext) => Promise<boolean | null | undefined>;
}

export interface CliRuntimeOptions {
	/** Pre-loaded config from the CLI config loader. */
	config: TrustedAgentsConfig;

	/** CLI global options (for output formatting). */
	opts: GlobalOptions;

	/** Label identifying this runtime owner (for transport lock). */
	ownerLabel?: string;

	/** Whether to emit NDJSON events to stdout. */
	emitEvents?: boolean;

	/** Override hooks for transfer approval. */
	hooks?: CliTapServiceHooks;
}

/**
 * Create a TapRuntime configured for CLI usage.
 *
 * This is the bridge between the CLI host and the SDK. It:
 * - Resolves CLI-specific calendar provider
 * - Wires TTY-aware approval prompts (transfer, scheduling, meeting confirmation)
 * - Wires NDJSON event emission when requested
 * - Checks for test runtime overrides (loopback transport, fake executor)
 * - Delegates to the SDK's `createTapRuntime` for construction
 */
export async function createCliRuntime(options: CliRuntimeOptions): Promise<TapRuntime> {
	const { config, opts } = options;
	const dataDir = config.dataDir;
	const override = getCliRuntimeOverride(dataDir);
	const userHooks = options.hooks ?? {};

	// ── Context overrides (test vs production) ──

	const contextOptions: CreateTapRuntimeOptions["contextOptions"] = {};

	if (override?.createContext) {
		const parts = override.createContext(config);
		contextOptions.trustStore = parts.trustStore;
		contextOptions.resolver = parts.resolver;
		contextOptions.conversationLogger = parts.conversationLogger;
		contextOptions.requestJournal = parts.requestJournal;
	}

	if (override?.createTransport) {
		contextOptions.transport = override.createTransport(config, {
			trustStore: contextOptions.trustStore!,
			resolver: contextOptions.resolver!,
			conversationLogger: contextOptions.conversationLogger!,
			requestJournal: contextOptions.requestJournal!,
		});
	}

	// ── Calendar provider ──

	const calendarProvider = resolveConfiguredCalendarProvider(dataDir);

	// ── Scheduling handler ──

	const schedulingHandler = new SchedulingHandler({
		calendarProvider,
		hooks: {
			approveScheduling: async (approvalContext) => {
				printSchedulingRequest(approvalContext, opts);

				if (!process.stdin.isTTY) {
					return null;
				}

				return await promptYesNo("Approve scheduling request? [y/N] ");
			},
			log: (_level, message) => {
				info(message, opts);
			},
		},
	});

	// ── Service hooks ──

	const hooks: TapServiceHooks = {
		approveTransfer: async (approvalContext) => {
			printTransferRequest(approvalContext, opts);

			const decision = await userHooks.approveTransfer?.(approvalContext);
			if (decision !== undefined) {
				return decision;
			}

			if (!process.stdin.isTTY) {
				return null;
			}

			return await promptYesNo("Approve action? [y/N] ");
		},
		confirmMeeting: async (meeting) => {
			printProposedMeeting(meeting, opts);

			if (!process.stdin.isTTY) {
				return true;
			}

			return await promptYesNo("Confirm this meeting? [y/N] ");
		},
		executeTransfer: async (serviceConfig, request) =>
			(await override?.executeTransferAction?.(serviceConfig, request)) ??
			(await executeOnchainTransfer(
				serviceConfig,
				createConfiguredSigningProvider(serviceConfig),
				request,
			)),
		log: (_level, message) => {
			info(message, opts);
		},
		emitEvent: options.emitEvents
			? (payload) => {
					process.stdout.write(`${JSON.stringify(payload)}\n`);
				}
			: undefined,
	};

	// ── Build the SDK runtime ──

	const runtime = await createTapRuntime({
		dataDir,
		configOptions: {
			// Pass the chain from the CLI-loaded config so the SDK
			// resolves the same chain when it re-loads internally.
			chain: config.chain,
		},
		contextOptions,
		hooks,
		ownerLabel: options.ownerLabel,
		schedulingHandler,
		createSigningProvider: async (cfg: TrustedAgentsConfig) => createConfiguredSigningProvider(cfg),
	});

	// Eagerly initialize so CLI commands can access trustStore, resolver,
	// etc. without calling start() (which also starts the transport).
	await runtime.init();

	return runtime;
}

// ── Print helpers (ported from tap-service.ts) ──

function printTransferRequest(context: TapTransferApprovalContext, opts: GlobalOptions): void {
	const { contact, request, activeTransferGrants, ledgerPath } = context;
	const assetLabel = request.asset === "native" ? "ETH" : "USDC";

	info(
		`Action request from ${contact.peerDisplayName} (#${contact.peerAgentId}): send ${request.amount} ${assetLabel} on ${request.chain} to ${request.toAddress}`,
		opts,
	);
	if (request.note) {
		info(`Note: ${request.note}`, opts);
	}

	info("Matching active transfer grants for this request:", opts);
	if (activeTransferGrants.length === 0) {
		info("  - (none)", opts);
	} else {
		for (const grant of activeTransferGrants) {
			info(`  - ${summarizeGrant(grant)}`, opts);
		}
	}
	info(`Ledger path: ${ledgerPath}`, opts);
	info("The agent should use the grants and ledger as context for this decision.", opts);
}

function printSchedulingRequest(context: SchedulingApprovalContext, opts: GlobalOptions): void {
	const { contact, proposal, activeSchedulingGrants } = context;

	info(
		`Scheduling request from ${contact.peerDisplayName} (#${contact.peerAgentId}): "${proposal.title}" (${proposal.duration} min)`,
		opts,
	);
	info(`  Slots offered: ${proposal.slots.length}`, opts);
	for (const slot of proposal.slots) {
		info(`    ${slot.start} - ${slot.end}`, opts);
	}
	if (proposal.location) {
		info(`  Location: ${proposal.location}`, opts);
	}
	if (proposal.note) {
		info(`  Note: ${proposal.note}`, opts);
	}

	info("Matching active scheduling grants:", opts);
	if (activeSchedulingGrants.length === 0) {
		info("  - (none)", opts);
	} else {
		for (const grant of activeSchedulingGrants) {
			info(`  - ${summarizeGrant(grant)}`, opts);
		}
	}
}

function printProposedMeeting(meeting: ProposedMeeting, opts: GlobalOptions): void {
	info(
		`Proposed meeting: "${meeting.title}" with ${meeting.peerName} (#${meeting.peerAgentId})`,
		opts,
	);
	info(`  Time: ${meeting.slot.start} - ${meeting.slot.end}`, opts);
	info(`  Timezone: ${meeting.originTimezone}`, opts);
}
