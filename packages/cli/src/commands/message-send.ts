import { DEFAULT_MESSAGE_SCOPE } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success, verbose } from "../lib/output.js";
import { TapdClient } from "../lib/tapd-client.js";
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
		const client = await TapdClient.forDataDir(config.dataDir);
		const scope = cmdOpts?.scope?.trim() || DEFAULT_MESSAGE_SCOPE;
		verbose(`Sending message to ${peer}...`, opts);

		const result = await client.sendMessage({ peer, text, scope });

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
		handleCommandError(err, opts);
	}
}
