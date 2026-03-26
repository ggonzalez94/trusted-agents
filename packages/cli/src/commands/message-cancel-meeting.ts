import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
import type { GlobalOptions } from "../types.js";

export interface CancelMeetingOptions {
	reason?: string;
	dryRun?: boolean;
}

export async function messageCancelMeetingCommand(
	schedulingId: string,
	cmdOpts: CancelMeetingOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		if (cmdOpts.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					scheduling_id: schedulingId,
					...(cmdOpts.reason ? { reason: cmdOpts.reason } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);
		const service = createCliTapMessagingService(ctx, opts, {
			ownerLabel: "tap:cancel-meeting",
		});

		verbose(`Cancelling meeting ${schedulingId}...`, opts);
		const result = await service.cancelMeeting(schedulingId, cmdOpts.reason);

		success(
			{
				cancelled: true,
				scheduling_id: schedulingId,
				request_id: result.requestId,
				peer_agent_id: result.peerAgentId,
				...(cmdOpts.reason ? { reason: cmdOpts.reason } : {}),
				pending_requests: result.report.pendingRequests.length,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
