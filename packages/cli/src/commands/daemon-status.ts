import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import { TapdClient, TapdClientError, TapdNotRunningError } from "../lib/tapd-client.js";
import { isProcessAlive } from "../lib/tapd-spawn.js";
import type { GlobalOptions } from "../types.js";

const PID_FILE = ".tapd.pid";
const PORT_FILE = ".tapd.port";

async function checkStalePidfile(dataDir: string): Promise<string | null> {
	const pidPath = join(dataDir, PID_FILE);
	if (!existsSync(pidPath)) return null;
	let pid: number;
	try {
		pid = Number.parseInt((await readFile(pidPath, "utf-8")).trim(), 10);
	} catch {
		return null;
	}
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (isProcessAlive(pid)) return null;
	// The pidfile points at a dead process. Clean up both files so the next
	// `tap daemon start` gets a fresh slate, and surface a clear error rather
	// than letting the operator think tapd is healthy.
	await rm(pidPath, { force: true }).catch(() => {});
	await rm(join(dataDir, PORT_FILE), { force: true }).catch(() => {});
	return `tapd exited (pidfile was stale for pid ${pid})`;
}

export async function daemonStatusCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		// Guard against stale pidfiles before touching the network. If the
		// pidfile points at a dead process, cleaning up here prevents the
		// split-brain path where a stale port file still exists for a dead
		// daemon (finding F3.2).
		const staleMessage = await checkStalePidfile(dataDir);
		if (staleMessage) {
			error("DAEMON_ERROR", staleMessage, opts);
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
