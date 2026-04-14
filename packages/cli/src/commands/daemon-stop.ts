import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { info, success } from "../lib/output.js";
import { stopTapdDetached } from "../lib/tapd-spawn.js";
import type { GlobalOptions } from "../types.js";

export async function daemonStopCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		info(`Stopping tapd in ${dataDir}...`, opts);
		const pid = await stopTapdDetached(dataDir);
		success(
			{
				stopped: true,
				pid,
				data_dir: dataDir,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
