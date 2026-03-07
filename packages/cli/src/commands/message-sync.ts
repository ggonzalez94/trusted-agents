import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { createMessageRuntime } from "../lib/message-runtime.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function messageSyncCommand(
	opts: GlobalOptions,
	cmdOpts?: { yes?: boolean; yesActions?: boolean },
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);
		const runtime = createMessageRuntime(config, ctx, opts, {
			autoApproveConnections: cmdOpts?.yes ?? false,
			autoApproveActions: cmdOpts?.yesActions ?? false,
			emitEvents: false,
		});

		ctx.transport.setHandlers(runtime.handlers);
		await ctx.transport.start?.();
		try {
			const reconciled = await ctx.transport.reconcile?.();
			await runtime.drain();
			const pending = await ctx.requestJournal.listPending();

			success(
				{
					synced: true,
					processed: reconciled?.processed ?? 0,
					pending_requests: pending.map((entry) => ({
						request_id: entry.requestId,
						method: entry.method,
						peer_agent_id: entry.peerAgentId,
						direction: entry.direction,
						kind: entry.kind,
						status: entry.status,
						correlation_id: entry.correlationId,
					})),
				},
				opts,
				startTime,
			);
		} finally {
			await ctx.transport.stop?.();
		}
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
