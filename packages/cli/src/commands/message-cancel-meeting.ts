import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContext } from "../lib/context.js";
import { handleCommandError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
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
			const config = await loadConfig(opts);
			const ctx = buildContext(config);
			const entries = await ctx.requestJournal.list();
			const match = entries.find((entry) => {
				const request = entry.metadata?.request;
				if (typeof request !== "object" || request === null) return false;
				const req = request as { type?: string; payload?: { schedulingId?: string } };
				return req.type === "scheduling-request" && req.payload?.schedulingId === schedulingId;
			});

			if (!match) {
				error("NOT_FOUND", `No scheduling request found with schedulingId: ${schedulingId}`, opts);
				process.exitCode = 4;
				return;
			}

			success(
				{
					status: "preview",
					dry_run: true,
					scope: "scheduling/cancel",
					scheduling_id: schedulingId,
					request_id: match.requestId,
					peer_agent_id: match.peerAgentId,
					...(cmdOpts.reason ? { reason: cmdOpts.reason } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		const config = await loadConfig(opts);
		const { service } = await createCliRuntime({
			config,
			opts,
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
		handleCommandError(err, opts);
	}
}
