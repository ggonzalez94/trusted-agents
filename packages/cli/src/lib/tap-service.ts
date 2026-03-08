import {
	type ConnectionPermissionIntent,
	type ResolvedAgent,
	type TapConnectionApprovalContext,
	TapMessagingService,
	type TapTransferApprovalContext,
	executeOnchainTransfer,
	summarizeGrant,
} from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import type { CliContextWithTransport } from "./context.js";
import { info } from "./output.js";
import { promptYesNo } from "./prompt.js";
import { getCliRuntimeOverride } from "./runtime-overrides.js";

export interface CliTapServiceHooks {
	approveConnection?: (
		peer: ResolvedAgent,
		intent: ConnectionPermissionIntent | undefined,
		context: TapConnectionApprovalContext,
	) => Promise<boolean | null | undefined>;
	approveTransfer?: (context: TapTransferApprovalContext) => Promise<boolean | null | undefined>;
}

export interface CliTapServiceOptions {
	autoApproveConnections?: boolean;
	unsafeAutoApproveActions?: boolean;
	emitEvents?: boolean;
	ownerLabel?: string;
	hooks?: CliTapServiceHooks;
}

export function createCliTapMessagingService(
	context: CliContextWithTransport,
	opts: GlobalOptions,
	options: CliTapServiceOptions = {},
): TapMessagingService {
	const hooks = options.hooks ?? {};

	return new TapMessagingService(context, {
		autoApproveConnections: options.autoApproveConnections ?? false,
		unsafeAutoApproveActions: options.unsafeAutoApproveActions ?? false,
		ownerLabel: options.ownerLabel,
		hooks: {
			approveConnection: async (approvalContext) => {
				printConnectionRequest(approvalContext.peer, approvalContext.intent, opts);

				const decision = await hooks.approveConnection?.(
					approvalContext.peer,
					approvalContext.intent,
					approvalContext,
				);
				if (decision !== undefined) {
					return decision;
				}

				if (!process.stdin.isTTY) {
					return null;
				}

				return await promptYesNo("Accept? [y/N] ");
			},
			approveTransfer: async (approvalContext) => {
				printTransferRequest(approvalContext, opts);

				const decision = await hooks.approveTransfer?.(approvalContext);
				if (decision !== undefined) {
					return decision;
				}

				if (!process.stdin.isTTY) {
					return null;
				}

				return await promptYesNo("Approve action? [y/N] ");
			},
			executeTransfer: async (serviceConfig, request) =>
				(await getCliRuntimeOverride(serviceConfig.dataDir)?.executeTransferAction?.(
					serviceConfig,
					request,
				)) ?? (await executeOnchainTransfer(serviceConfig, request)),
			log: (_level, message) => {
				info(message, opts);
			},
			emitEvent: options.emitEvents
				? (payload) => {
						process.stdout.write(`${JSON.stringify(payload)}\n`);
					}
				: undefined,
		},
	});
}

function printConnectionRequest(
	peer: ResolvedAgent,
	intent: ConnectionPermissionIntent | undefined,
	opts: GlobalOptions,
): void {
	info(
		`Connection request from ${peer.registrationFile.name} (#${peer.agentId}) on ${peer.chain}`,
		opts,
	);
	info(`Capabilities: ${peer.capabilities.join(", ")}`, opts);
	info(
		"Connection establishes trust only; any grants requested or offered are exchanged separately.",
		opts,
	);

	if (!intent?.requestedGrants?.length && !intent?.offeredGrants?.length) {
		info("No initial grant requests or grant publications were included.", opts);
		return;
	}

	if (intent.requestedGrants?.length) {
		info("Peer intends to request these grants after connect:", opts);
		for (const grant of intent.requestedGrants) {
			info(`  - ${summarizeGrant(grant)}`, opts);
		}
	}

	if (intent.offeredGrants?.length) {
		info("Peer intends to publish these grants after connect:", opts);
		for (const grant of intent.offeredGrants) {
			info(`  - ${summarizeGrant(grant)}`, opts);
		}
	}
}

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
