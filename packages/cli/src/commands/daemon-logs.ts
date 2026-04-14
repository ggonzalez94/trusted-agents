import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, info } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function daemonLogsCommand(
	opts: GlobalOptions,
	cmdOpts?: { follow?: boolean },
): Promise<void> {
	try {
		const dataDir = resolveDataDir(opts);
		const logPath = join(dataDir, ".tapd.log");

		if (!existsSync(logPath)) {
			error(
				"NOT_FOUND",
				`No tapd log at ${logPath}. Start tapd with 'tap daemon start' so logs are written to this file.`,
				opts,
			);
			process.exitCode = 4;
			return;
		}

		// One-shot dump.
		await new Promise<void>((resolve, reject) => {
			const stream = createReadStream(logPath, { encoding: "utf-8" });
			stream.on("data", (chunk) => process.stdout.write(chunk));
			stream.on("end", () => resolve());
			stream.on("error", reject);
		});

		if (!cmdOpts?.follow) return;

		info(`\n# Following ${logPath} (Ctrl+C to stop)...`, opts);
		let position = statSync(logPath).size;
		const watcher = watch(logPath, () => {
			const size = statSync(logPath).size;
			if (size <= position) return;
			const stream = createReadStream(logPath, {
				encoding: "utf-8",
				start: position,
				end: size,
			});
			stream.on("data", (chunk) => process.stdout.write(chunk));
			position = size;
		});

		const cleanup = () => {
			watcher.close();
			process.exit(0);
		};
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);

		await new Promise(() => {});
	} catch (err) {
		handleCommandError(err, opts);
	}
}
