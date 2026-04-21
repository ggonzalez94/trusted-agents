import { spawn } from "node:child_process";
import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { info, success } from "../lib/output.js";
import { TapdNotRunningError, type TapdUiInfo, discoverTapdUiUrl } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

/**
 * Milliseconds to wait after `spawn` for the child's async `error` event
 * before assuming the launch succeeded. `child_process.spawn` resolves
 * command lookup asynchronously on POSIX, so on a system without
 * `open`/`xdg-open` the missing-binary error only arrives a few ticks
 * later. 250ms is long enough to catch `ENOENT` in practice while keeping
 * the `tap ui` command from feeling laggy. Any failure that takes longer
 * than this (e.g. the browser itself refuses to render) is out of scope —
 * we only care about "did the opener process launch at all?".
 */
const BROWSER_OPEN_ERROR_WINDOW_MS = 250;

function openInBrowser(url: string): Promise<boolean> {
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

	return new Promise<boolean>((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: "ignore", detached: true });
		} catch {
			resolve(false);
			return;
		}

		let settled = false;
		const settle = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};

		// Async `ENOENT` / permission errors on POSIX arrive on the child as
		// an `error` event. Treat them as launch failures so the caller falls
		// back to printing the full token-bearing URL. Without this the
		// command optimistically reports success and the user gets no URL
		// they can copy manually (the token URL is intentionally suppressed
		// from stdout/--json on the happy path — see comment on the call
		// site below).
		child.once("error", () => settle(false));
		setTimeout(() => {
			child.unref();
			settle(true);
		}, BROWSER_OPEN_ERROR_WINDOW_MS);
	});
}

export async function uiCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		let connection: TapdUiInfo;
		try {
			connection = await discoverTapdUiUrl(dataDir);
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
		const opened = await openInBrowser(tokenBearingUrl);

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
