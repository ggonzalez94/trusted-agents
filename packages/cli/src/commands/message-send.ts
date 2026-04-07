import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import {
	isQueuedTapCommandPending,
	queuedTapCommandPendingFields,
	queuedTapCommandResultFields,
	runOrQueueTapCommand,
} from "../lib/queued-commands.js";
import { DEFAULT_MESSAGE_SCOPE } from "../lib/scopes.js";
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
		const { service } = createCliRuntime({ config, opts, ownerLabel: "tap:message-send" });
		const scope = cmdOpts?.scope?.trim() || DEFAULT_MESSAGE_SCOPE;
		verbose(`Sending message to ${peer}...`, opts);
		const outcome = await runOrQueueTapCommand(
			config.dataDir,
			{
				type: "send-message",
				payload: { peer, text, scope },
			},
			async () => await service.sendMessage(peer, text, scope),
			{
				requestedBy: "tap:message-send",
			},
		);

		if (isQueuedTapCommandPending(outcome)) {
			success(
				{
					...queuedTapCommandPendingFields(outcome),
					peer,
					scope,
				},
				opts,
				startTime,
			);
			return;
		}

		const result = outcome.result;

		success(
			{
				sent: true,
				...queuedTapCommandResultFields(outcome),
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
