import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import {
	type MessageRuntimeHooks,
	type TransferApprovalContext,
	createMessageRuntime,
} from "../lib/message-runtime.js";
import { error, info } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export interface MessageListenerHooks extends MessageRuntimeHooks {
	announce?: boolean;
}

export type { TransferApprovalContext };

export interface MessageListenerSession {
	stop(): Promise<void>;
}

export async function messageListenCommand(
	opts: GlobalOptions,
	cmdOpts?: { yes?: boolean; yesActions?: boolean },
): Promise<void> {
	try {
		const session = await createMessageListenerSession(opts, cmdOpts);

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
	cmdOpts?: { yes?: boolean; yesActions?: boolean },
	hooks?: MessageListenerHooks,
): Promise<MessageListenerSession> {
	const config = await loadConfig(opts);
	const ctx = buildContextWithTransport(config);
	const runtime = createMessageRuntime(config, ctx, opts, {
		autoApproveConnections: cmdOpts?.yes ?? false,
		autoApproveActions: cmdOpts?.yesActions ?? false,
		emitEvents: true,
		hooks,
	});

	if (hooks?.announce !== false) {
		info("Listening for incoming messages... (Ctrl+C to stop)", opts);
	}

	ctx.transport.setHandlers(runtime.handlers);
	await ctx.transport.start?.();
	await ctx.transport.reconcile?.();
	await runtime.drain();

	return {
		stop: async () => {
			await runtime.drain();
			await ctx.transport.stop?.();
		},
	};
}
