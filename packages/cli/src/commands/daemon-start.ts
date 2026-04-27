import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { portFilePath } from "trusted-agents-tapd";
import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, info, success } from "../lib/output.js";
import { cleanupTapdStateFiles, inspectTapdProcess, spawnTapdDetached } from "../lib/tapd-spawn.js";
import type { GlobalOptions } from "../types.js";

export async function daemonStartCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		const portFile = portFilePath(dataDir);
		const inspection = await inspectTapdProcess(dataDir);
		if (inspection.status === "unknown") {
			error("DAEMON_ERROR", inspection.message ?? "Could not verify existing tapd owner", opts);
			process.exitCode = 2;
			return;
		}
		if (inspection.status === "running") {
			error(
				"ALREADY_RUNNING",
				`tapd appears to already be running (port file at ${portFile}). Run 'tap daemon stop' first or 'tap daemon status' to inspect.`,
				opts,
			);
			process.exitCode = 2;
			return;
		}
		if (inspection.status === "dead" || inspection.status === "mismatch") {
			await cleanupTapdStateFiles(dataDir);
		} else if (existsSync(portFile)) {
			await rm(portFile, { force: true }).catch(() => {});
		}

		info(`Starting tapd in ${dataDir}...`, opts);
		const result = await spawnTapdDetached({ dataDir });
		success(
			{
				started: true,
				pid: result.pid,
				port: result.port,
				log_path: result.logPath,
				pid_path: result.pidPath,
				data_dir: dataDir,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
