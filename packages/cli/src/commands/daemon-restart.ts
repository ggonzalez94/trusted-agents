import { existsSync } from "node:fs";
import { pidFilePath } from "trusted-agents-tapd";
import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { info, success } from "../lib/output.js";
import {
	cleanupTapdStateFiles,
	inspectTapdProcess,
	spawnTapdDetached,
	stopTapdDetached,
} from "../lib/tapd-spawn.js";
import type { GlobalOptions } from "../types.js";

export async function daemonRestartCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		const pidFile = pidFilePath(dataDir);
		let stoppedPid: number | undefined;

		if (existsSync(pidFile)) {
			const inspection = await inspectTapdProcess(dataDir);
			if (inspection.status === "running" || inspection.status === "dead") {
				info(`Stopping existing tapd in ${dataDir}...`, opts);
				stoppedPid = await stopTapdDetached(dataDir);
			} else if (inspection.status === "mismatch") {
				await cleanupTapdStateFiles(dataDir);
			} else if (inspection.status === "unknown") {
				throw new Error(inspection.message ?? "Could not verify existing tapd owner");
			}
		}

		info(`Starting tapd in ${dataDir}...`, opts);
		const result = await spawnTapdDetached({ dataDir });

		success(
			{
				restarted: true,
				stopped_pid: stoppedPid,
				pid: result.pid,
				port: result.port,
				log_path: result.logPath,
				data_dir: dataDir,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
