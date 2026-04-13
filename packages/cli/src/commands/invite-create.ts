import { generateInvite } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import { createConfiguredSigningProvider } from "../lib/wallet-config.js";
import type { GlobalOptions } from "../types.js";

export async function inviteCreateCommand(
	expirySeconds: number,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const signingProvider = createConfiguredSigningProvider(config);

		const result = await generateInvite({
			agentId: config.agentId,
			chain: config.chain,
			signingProvider,
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
		handleCommandError(err, opts);
	}
}
