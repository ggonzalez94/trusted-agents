import {
	SchedulingHandler,
	TapMessagingService,
	type TapTransferApprovalContext,
	executeOnchainTransfer,
	summarizeGrant,
} from "trusted-agents-core";
import type { ProposedMeeting, SchedulingApprovalContext } from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import type { CliContextWithTransport } from "./context.js";
import { info } from "./output.js";
import { promptYesNo } from "./prompt.js";
import { getCliRuntimeOverride } from "./runtime-overrides.js";

export interface CliTapServiceHooks {
	approveTransfer?: (context: TapTransferApprovalContext) => Promise<boolean | null | undefined>;
}

export interface CliTapServiceOptions {
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

	const schedulingHandler = new SchedulingHandler({
		calendarProvider: context.calendarProvider,
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

	return new TapMessagingService(context, {
		ownerLabel: options.ownerLabel,
		schedulingHandler,
		hooks: {
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
			confirmMeeting: async (meeting) => {
				printProposedMeeting(meeting, opts);

				if (!process.stdin.isTTY) {
					return true;
				}

				return await promptYesNo("Confirm this meeting? [y/N] ");
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
