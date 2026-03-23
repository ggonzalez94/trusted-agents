import {
	checkGwsAuthenticated,
	checkGwsInstalled,
	runGwsAuth,
	writeCalendarConfig,
} from "../lib/calendar/setup.js";
import { resolveDataDir } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, info, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function calendarSetupCommand(
	cmdOpts: { provider?: string },
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();
	const provider = cmdOpts.provider ?? "google";

	try {
		if (provider !== "google") {
			throw new Error(
				`Unsupported calendar provider: ${provider}. Currently only "google" is supported.`,
			);
		}

		const dataDir = resolveDataDir(opts);

		// 1. Check gws installed
		info("Checking for gws CLI...", opts);
		const installed = await checkGwsInstalled();
		if (!installed) {
			throw new Error(
				"gws CLI not found on PATH. Install it from https://github.com/nicholasgasior/gws",
			);
		}
		info("gws CLI found.", opts);

		// 2. Check auth
		info("Checking gws authentication...", opts);
		let authenticated = await checkGwsAuthenticated();
		if (!authenticated) {
			info("Not authenticated. Starting gws auth login...", opts);
			const authOk = await runGwsAuth();
			if (!authOk) {
				throw new Error("gws authentication failed. Run 'gws auth login -s calendar' manually.");
			}

			// Verify
			authenticated = await checkGwsAuthenticated();
			if (!authenticated) {
				throw new Error(
					"gws authentication completed but calendar access could not be verified. Try running 'gws calendar +agenda' manually.",
				);
			}
		}
		info("gws authenticated with calendar access.", opts);

		// 3. Write config
		await writeCalendarConfig(dataDir, provider);

		success(
			{
				configured: true,
				provider,
				data_dir: dataDir,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
