import { type TapPendingSchedulingDetails, ValidationError } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
import type { GlobalOptions } from "../types.js";

export interface CancelMeetingOptions {
	reason?: string;
}

export async function messageCancelMeetingCommand(
	schedulingId: string,
	cmdOpts: CancelMeetingOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);
		const service = createCliTapMessagingService(ctx, opts, {
			ownerLabel: "tap:cancel-meeting",
		});

		verbose(`Cancelling scheduling request ${schedulingId}...`, opts);

		// Look for a pending scheduling request in the pending requests
		const pendingRequests = await service.listPendingRequests();
		const matching = pendingRequests.find(
			(r) =>
				r.direction === "outbound" &&
				r.details?.type === "scheduling" &&
				(r.details as TapPendingSchedulingDetails).schedulingId === schedulingId,
		);

		if (!matching) {
			throw new ValidationError(
				`No scheduling request found with schedulingId: ${schedulingId}. It may have already been completed or cancelled.`,
			);
		}

		const report = await service.cancelPendingSchedulingRequest(matching.requestId, cmdOpts.reason);

		success(
			{
				cancelled: true,
				scheduling_id: schedulingId,
				request_id: matching.requestId,
				peer_agent_id: matching.peerAgentId,
				...(cmdOpts.reason ? { reason: cmdOpts.reason } : {}),
				pending_requests: report.pendingRequests.length,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
