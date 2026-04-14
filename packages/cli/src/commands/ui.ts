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
		// the browser history or referrer headers.
		const url = `${connection.baseUrl}/#token=${connection.token}`;
		const opened = openInBrowser(url);

		if (opened) {
			info(`Opened tapd UI in your browser: ${url}`, opts);
		} else {
			info(`Open this URL in your browser: ${url}`, opts);
		}

		success(
			{
				url,
				base_url: connection.baseUrl,
				opened,
				data_dir: dataDir,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
