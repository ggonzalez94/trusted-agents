import { generateInvite } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function inviteCreateCommand(
	expirySeconds: number,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);

		const result = await generateInvite({
			agentId: config.agentId,
			chain: config.chain,
			privateKey: config.privateKey,
			expirySeconds,
		});

		success(
			{
				url: result.url,
				expires_in_seconds: expirySeconds,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
