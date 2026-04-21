import { ValidationError } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success, verbose } from "../lib/output.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

export interface RespondMeetingOptions {
	accept?: boolean;
	reject?: boolean;
	reason?: string;
	dryRun?: boolean;
}

/**
 * `tap message respond-meeting` — accept or reject a pending scheduling
 * request. The lookup-by-schedulingId happens in tapd's meetings route.
 */
export async function messageRespondMeetingCommand(
	schedulingId: string,
	cmdOpts: RespondMeetingOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		if (!cmdOpts.accept && !cmdOpts.reject) {
			throw new ValidationError("One of --accept or --reject is required");
		}
		if (cmdOpts.accept && cmdOpts.reject) {
			throw new ValidationError("Cannot use both --accept and --reject");
		}

		const config = await loadConfig(opts);
		const approve = !!cmdOpts.accept;

		if (cmdOpts.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					scope: "scheduling/respond",
					scheduling_id: schedulingId,
					action: approve ? "accept" : "reject",
					...(cmdOpts.reason ? { reason: cmdOpts.reason } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		verbose(`${approve ? "Accepting" : "Rejecting"} scheduling request ${schedulingId}...`, opts);

		const client = await TapdClient.forDataDir(config.dataDir);
		const result = await client.respondMeeting(schedulingId, {
			approve,
			reason: cmdOpts.reason,
		});

		success(
			{
				resolved: true,
				scheduling_id: schedulingId,
				action: approve ? "accepted" : "rejected",
				request_id: result.requestId,
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
