import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function configShowCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);

		const redacted = {
			agent_id: config.agentId,
			chain: config.chain,
			ows: {
				wallet: config.ows.wallet,
				api_key: "***redacted***",
			},
			data_dir: config.dataDir,
			invite_expiry_seconds: config.inviteExpirySeconds,
			execution: {
				mode: config.execution?.mode,
				paymaster_provider: config.execution?.paymasterProvider,
			},
			ipfs: {
				provider: config.ipfs?.provider ?? "auto",
				tack_api_url: config.ipfs?.tackApiUrl,
			},
			chains: Object.fromEntries(
				Object.entries(config.chains).map(([k, v]) => [
					k,
					{ name: v.name, rpc_url: v.rpcUrl, registry: v.registryAddress },
				]),
			),
		};

		success(redacted, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
