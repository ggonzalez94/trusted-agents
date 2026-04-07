import { ValidationError } from "trusted-agents-core";
import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export interface RespondMeetingOptions {
	accept?: boolean;
	reject?: boolean;
	reason?: string;
	dryRun?: boolean;
}

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
		const { service } = createCliRuntime({
			config,
			opts,
			ownerLabel: "tap:respond-meeting",
		});

		const approve = !!cmdOpts.accept;

		verbose(`${approve ? "Accepting" : "Rejecting"} scheduling request ${schedulingId}...`, opts);

		// Find the pending request matching this schedulingId
		const pendingRequests = await service.listPendingRequests();
		const matching = pendingRequests.find(
			(r) =>
				r.direction === "inbound" &&
				r.details?.type === "scheduling" &&
				(r.details as { schedulingId?: string }).schedulingId === schedulingId,
		);

		if (!matching) {
			throw new ValidationError(
				`No pending scheduling request found with schedulingId: ${schedulingId}`,
			);
		}

		if (cmdOpts.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					scope: "scheduling/respond",
					scheduling_id: schedulingId,
					action: approve ? "accept" : "reject",
					request_id: matching.requestId,
					peer_agent_id: matching.peerAgentId,
					...(cmdOpts.reason ? { reason: cmdOpts.reason } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		const report = await service.resolvePending(matching.requestId, approve, cmdOpts.reason);

		success(
			{
				resolved: true,
				scheduling_id: schedulingId,
				action: approve ? "accepted" : "rejected",
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
