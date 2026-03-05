import { FilePendingInviteStore, generateInvite } from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { error, success } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";

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

		// Store the pending invite
		const store = new FilePendingInviteStore(config.dataDir);
		await store.create(result.invite.nonce, result.invite.expires);

		success(
			{
				url: result.url,
				nonce: result.invite.nonce,
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
