import { request } from "node:http";
import type { CliTapServiceHooks } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, info } from "../lib/output.js";
import { discoverTapd } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

export type { TapTransferApprovalContext as TransferApprovalContext } from "trusted-agents-core";

export interface MessageListenerHooks extends CliTapServiceHooks {
	announce?: boolean;
}

/**
 * @deprecated In Phase 3 the production `tap message listen` command became
 * an SSE tail of tapd. This stub remains as a no-op so legacy e2e tests that
 * still call it keep importing the same name; behavior moves into the
 * in-process tapd helper. Hooks and lock acquisition no longer happen here.
 */
export interface MessageListenerSession {
	stop(): Promise<void>;
}

export async function createMessageListenerSession(
	_opts: GlobalOptions,
	_hooks?: MessageListenerHooks,
): Promise<MessageListenerSession> {
	return {
		stop: async () => {
			// no-op: see @deprecated note above
		},
	};
}

/**
 * `tap message listen` — tail the live tapd SSE event stream. The CLI is now a
 * thin reader: it opens `/api/events/stream`, demuxes SSE blocks, and writes
 * each `data:` line to stdout. The daemon owns the transport.
 *
 * **Breaking change:** the output format is the SSE event JSON shape exposed
 * by tapd, not the legacy NDJSON-from-`emitEvent` shape. Scripts that parse
 * `tap message listen` should expect `TapEvent` objects (see
 * `packages/core/src/runtime/event-types.ts`).
 */
export async function messageListenCommand(opts: GlobalOptions): Promise<void> {
	try {
		const config = await loadConfig(opts);
		const { socketPath, token } = await discoverTapd(config.dataDir);

		info(`Listening for incoming messages from ${socketPath}... (Ctrl+C to stop)`, opts);

		await new Promise<void>((resolve, reject) => {
			const req = request(
				{
					socketPath,
					method: "GET",
					path: "/api/events/stream",
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "text/event-stream",
					},
				},
				(res) => {
					const status = res.statusCode ?? 0;
					if (status !== 200) {
						error("STREAM_ERROR", `tapd SSE stream failed with status ${status}`, opts);
						process.exitCode = 2;
						res.resume();
						resolve();
						return;
					}

					res.setEncoding("utf-8");
					let buffer = "";

					const cleanup = () => {
						res.destroy();
						resolve();
						process.exit(0);
					};
					process.on("SIGINT", cleanup);
					process.on("SIGTERM", cleanup);

					res.on("data", (chunk: string) => {
						buffer += chunk;
						while (buffer.includes("\n\n")) {
							const idx = buffer.indexOf("\n\n");
							const block = buffer.slice(0, idx);
							buffer = buffer.slice(idx + 2);
							const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
							if (dataLine) {
								process.stdout.write(`${dataLine.slice("data: ".length)}\n`);
							}
						}
					});
					res.on("end", () => resolve());
					res.on("error", reject);
				},
			);
			req.on("error", reject);
			req.end();
		});
	} catch (err) {
		handleCommandError(err, opts);
	}
}
