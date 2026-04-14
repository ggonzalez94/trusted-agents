import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import { TapdClient, TapdClientError, TapdNotRunningError } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

export async function daemonStatusCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		let client: TapdClient;
		try {
			client = await TapdClient.forDataDir(dataDir);
		} catch (err) {
			if (err instanceof TapdNotRunningError) {
				success({ running: false, data_dir: dataDir }, opts, startTime);
				return;
			}
			throw err;
		}

		try {
			const health = await client.health();
			success(
				{
					running: true,
					data_dir: dataDir,
					base_url: client.baseUrl,
					version: health.version,
					uptime_ms: health.uptime,
					transport_connected: health.transportConnected,
					last_sync_at: health.lastSyncAt,
				},
				opts,
				startTime,
			);
		} catch (err) {
			if (err instanceof TapdClientError) {
				error("DAEMON_ERROR", `tapd health check failed: ${err.message}`, opts);
				process.exitCode = 2;
				return;
			}
			throw err;
		}
	} catch (err) {
		handleCommandError(err, opts);
	}
}
