import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import { DEFAULT_MESSAGE_SCOPE } from "../lib/scopes.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
import type { GlobalOptions } from "../types.js";

export async function messageSendCommand(
	peer: string,
	text: string,
	opts: GlobalOptions,
	cmdOpts?: { scope?: string },
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);
		const scope = cmdOpts?.scope?.trim() || DEFAULT_MESSAGE_SCOPE;
		verbose(`Sending message to ${peer}...`, opts);
		const service = createCliTapMessagingService(ctx, opts, {
			ownerLabel: "tap:message-send",
		});
		const result = await service.sendMessage(peer, text, scope);

		success(
			{
				sent: true,
				peer: result.peerName,
				agent_id: result.peerAgentId,
				scope: result.scope,
				receipt: result.receipt,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
