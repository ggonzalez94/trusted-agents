import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function messageSyncCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const { service } = await createCliRuntime({
			config,
			opts,
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
		handleCommandError(err, opts);
	}
}
