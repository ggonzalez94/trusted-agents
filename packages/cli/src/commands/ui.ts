import { spawn } from "node:child_process";
import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { info, success } from "../lib/output.js";
import { type TapdConnectionInfo, TapdNotRunningError, discoverTapd } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

function openInBrowser(url: string): boolean {
	const platform = process.platform;
	let command: string;
	let args: string[];
	if (platform === "darwin") {
		command = "open";
		args = [url];
	} else if (platform === "win32") {
		command = "cmd";
		args = ["/c", "start", "", url];
	} else {
		command = "xdg-open";
		args = [url];
	}

	try {
		const child = spawn(command, args, {
			stdio: "ignore",
			detached: true,
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

export async function uiCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		let connection: TapdConnectionInfo;
		try {
			connection = await discoverTapd(dataDir);
		} catch (err) {
			if (err instanceof TapdNotRunningError) {
				throw new Error(
					"tapd is not running. Start it first with `tap daemon start`, then re-run `tap ui`.",
				);
			}
			throw err;
		}

		// The UI reads the bearer token from the URL hash so it never lands in
		// the browser history or referrer headers. The token-bearing URL also
		// must not land in terminal logs, --json output, or CI capture when we
		// don't need to show it: echoing the token to stdout/structured output
		// defeats the protections above, since it authorizes the daemon
		// control and write APIs. When we open the browser for the user we
		// hand the URL to the OS directly and only echo the base URL; only
		// when auto-open fails do we print the full URL (the user has no
		// other way to reach it).
		const tokenBearingUrl = `${connection.baseUrl}/#token=${connection.token}`;
		const opened = openInBrowser(tokenBearingUrl);

		if (opened) {
			info(`Opened tapd UI in your browser: ${connection.baseUrl}/`, opts);
		} else {
			info(`Open this URL in your browser: ${tokenBearingUrl}`, opts);
		}

		success(
			{
				base_url: connection.baseUrl,
				opened,
				// Only surface the token-bearing URL when the user has to copy
				// it by hand; otherwise structured consumers shouldn't see it.
				...(opened ? {} : { url: tokenBearingUrl }),
				data_dir: dataDir,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
