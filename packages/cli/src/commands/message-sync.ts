import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

/**
 * `tap message sync` — trigger one reconcile cycle inside tapd. The daemon
 * runs the reconcile and returns the resulting `TapSyncReport`; the CLI just
 * formats it.
 */
export async function messageSyncCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const client = await TapdClient.forDataDir(config.dataDir);
		const result = await client.triggerSync();
		const report = result.report;

		success(
			{
				synced: report?.synced ?? true,
				processed: report?.processed ?? 0,
				pending_requests:
					report?.pendingRequests.map((entry) => ({
						request_id: entry.requestId,
						method: entry.method,
						peer_agent_id: entry.peerAgentId,
						direction: entry.direction,
						kind: entry.kind,
						status: entry.status,
						correlation_id: entry.correlationId,
					})) ?? [],
				pending_deliveries:
					report?.pendingDeliveries.map((entry) => ({
						request_id: entry.requestId,
						method: entry.method,
						peer_agent_id: entry.peerAgentId,
						correlation_id: entry.correlationId,
						age_ms: entry.ageMs,
						attempts: entry.attempts,
						last_attempt_at: entry.lastAttemptAt,
						last_error: entry.lastError,
					})) ?? [],
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
