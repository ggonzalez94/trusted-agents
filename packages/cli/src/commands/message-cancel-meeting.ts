import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success, verbose } from "../lib/output.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

export interface CancelMeetingOptions {
	reason?: string;
	dryRun?: boolean;
}

/**
 * `tap message cancel-meeting` — cancel a previously requested or accepted
 * meeting. The cancellation flow lives entirely inside tapd.
 */
export async function messageCancelMeetingCommand(
	schedulingId: string,
	cmdOpts: CancelMeetingOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);

		if (cmdOpts.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					scope: "scheduling/cancel",
					scheduling_id: schedulingId,
					...(cmdOpts.reason ? { reason: cmdOpts.reason } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		verbose(`Cancelling meeting ${schedulingId}...`, opts);
		const client = await TapdClient.forDataDir(config.dataDir);
		const result = await client.cancelMeeting(schedulingId, cmdOpts.reason);

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
		handleCommandError(err, opts);
	}
}
