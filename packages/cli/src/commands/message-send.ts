import { DEFAULT_MESSAGE_SCOPE } from "trusted-agents-core";
import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success, verbose } from "../lib/output.js";
import {
	isQueuedTapCommandPending,
	queuedTapCommandPendingFields,
	queuedTapCommandResultFields,
	runOrQueueTapCommand,
} from "../lib/queued-commands.js";
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
		const { service } = await createCliRuntime({ config, opts, ownerLabel: "tap:message-send" });
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
		handleCommandError(err, opts);
	}
}
