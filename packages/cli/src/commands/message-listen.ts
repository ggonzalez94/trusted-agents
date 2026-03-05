import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { error, info } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";

export async function messageListenCommand(opts: GlobalOptions): Promise<void> {
	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);

		info("Listening for incoming messages... (Ctrl+C to stop)", opts);

		ctx.transport.onMessage(async (from, message) => {
			const line = JSON.stringify({
				timestamp: new Date().toISOString(),
				from,
				method: message.method,
				id: message.id,
				params: message.params,
			});
			process.stdout.write(`${line}\n`);

			return {
				jsonrpc: "2.0" as const,
				id: message.id,
				result: { received: true },
			};
		});

		await ctx.transport.start?.();

		// Handle graceful shutdown
		const shutdown = async () => {
			info("\nShutting down...", opts);
			await ctx.transport.stop?.();
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		// Keep alive
		await new Promise(() => {});
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
