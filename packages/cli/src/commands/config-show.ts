import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { error, success } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";

export async function configShowCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);

		const redacted = {
			agent_id: config.agentId,
			chain: config.chain,
			private_key: "***redacted***",
			data_dir: config.dataDir,
			invite_expiry_seconds: config.inviteExpirySeconds,
			xmtp_env: config.xmtpEnv ?? "production",
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
