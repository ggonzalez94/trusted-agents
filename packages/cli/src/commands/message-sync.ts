import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
import type { GlobalOptions } from "../types.js";

export async function messageSyncCommand(
	opts: GlobalOptions,
	cmdOpts?: { yes?: boolean; yesActions?: boolean },
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);
		const service = createCliTapMessagingService(ctx, opts, {
			autoApproveConnections: cmdOpts?.yes ?? false,
			autoApproveActions: cmdOpts?.yesActions ?? false,
			emitEvents: false,
			ownerLabel: "tap:sync",
		});
		const report = await service.syncOnce();

		success(
			{
				synced: report.synced,
				processed: report.processed,
				pending_requests: report.pendingRequests.map((entry) => ({
					request_id: entry.requestId,
					method: entry.method,
					peer_agent_id: entry.peerAgentId,
					direction: entry.direction,
					kind: entry.kind,
					status: entry.status,
					correlation_id: entry.correlationId,
				})),
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
