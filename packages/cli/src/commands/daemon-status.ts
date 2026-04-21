import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import {
	TapdClient,
	TapdClientError,
	TapdNotRunningError,
	discoverTapdUiUrl,
} from "../lib/tapd-client.js";
import { cleanupTapdStateFiles, inspectTapdProcess } from "../lib/tapd-spawn.js";
import type { GlobalOptions } from "../types.js";

export async function daemonStatusCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		// Guard against stale or mismatched pidfiles before touching the
		// network. If the pidfile points at a dead process or a recycled PID,
		// cleaning up here prevents status from reporting a healthy daemon
		// against stale local state.
		const inspection = await inspectTapdProcess(dataDir);
		if (inspection.status === "dead" || inspection.status === "mismatch") {
			await cleanupTapdStateFiles(dataDir);
			error("DAEMON_ERROR", inspection.message ?? "tapd pidfile was stale", opts);
			process.exitCode = 2;
			return;
		}
		if (inspection.status === "unknown") {
			error("DAEMON_ERROR", inspection.message ?? "Could not verify existing tapd owner", opts);
			process.exitCode = 2;
			return;
		}

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
			// `base_url` is the loopback URL the bundled web UI binds on. CLI
			// requests go over the Unix socket, but `tap daemon status` shows
			// the URL so operators can paste it into a browser.
			let baseUrl: string | undefined;
			try {
				baseUrl = (await discoverTapdUiUrl(dataDir)).baseUrl;
			} catch {
				baseUrl = undefined;
			}
			success(
				{
					running: true,
					data_dir: dataDir,
					socket_path: client.socketPath,
					base_url: baseUrl,
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
