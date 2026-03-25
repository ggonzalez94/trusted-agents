import { OwsSigningProvider } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { getExecutionPreview } from "../lib/execution.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function identityShowCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const signingProvider = new OwsSigningProvider(
			config.ows.wallet,
			config.chain,
			config.ows.apiKey,
		);
		const address = await signingProvider.getAddress();
		const chainConfig = config.chains[config.chain];
		const execution =
			chainConfig !== undefined
				? await getExecutionPreview(config, chainConfig, signingProvider)
				: undefined;

		success(
			{
				agent_id: config.agentId,
				chain: config.chain,
				address,
				messaging_address: address,
				execution_mode: execution?.mode,
				execution_address: execution?.executionAddress,
				funding_address: execution?.fundingAddress ?? address,
				paymaster_provider: execution?.paymasterProvider,
				warnings: execution?.warnings.length ? execution.warnings : undefined,
				data_dir: config.dataDir,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
