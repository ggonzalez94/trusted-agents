import { type CliTapServiceHooks, createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, info } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export interface MessageListenerHooks extends CliTapServiceHooks {
	announce?: boolean;
}

export type { TapTransferApprovalContext as TransferApprovalContext } from "trusted-agents-core";

export interface MessageListenerSession {
	stop(): Promise<void>;
}

export async function messageListenCommand(opts: GlobalOptions): Promise<void> {
	try {
		const session = await createMessageListenerSession(opts);

		const shutdown = async () => {
			info("\nShutting down...", opts);
			await session.stop();
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		await new Promise(() => {});
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

export async function createMessageListenerSession(
	opts: GlobalOptions,
	hooks?: MessageListenerHooks,
): Promise<MessageListenerSession> {
	const config = await loadConfig(opts);
	const { service } = createCliRuntime({
		config,
		opts,
		emitEvents: true,
		ownerLabel: "tap:listen",
		hooks,
	});

	if (hooks?.announce !== false) {
		info("Listening for incoming messages... (Ctrl+C to stop)", opts);
	}

	await service.start();

	return {
		stop: async () => {
			await service.stop();
		},
	};
}
