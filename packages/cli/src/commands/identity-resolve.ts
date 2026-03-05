import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContext } from "../lib/context.js";
import { error, success, verbose } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";

export async function identityResolveCommand(
	agentId: number,
	opts: GlobalOptions,
	chain?: string,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContext(config);
		const resolveChain = chain ?? config.chain;

		verbose(`Resolving agent ${agentId} on ${resolveChain}...`, opts);

		const agent = await ctx.resolver.resolve(agentId, resolveChain);

		success(
			{
				agent_id: agent.agentId,
				chain: agent.chain,
				owner: agent.ownerAddress,
				agent_address: agent.agentAddress,
				xmtp_endpoint: agent.xmtpEndpoint,
				name: agent.registrationFile.name,
				description: agent.registrationFile.description,
				capabilities: agent.capabilities,
				resolved_at: agent.resolvedAt,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
