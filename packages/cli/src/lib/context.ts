import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";
import {
	AgentResolver,
	FileTrustStore,
	XmtpTransport,
} from "trusted-agents-core";
import type {
	IAgentResolver,
	ITrustStore,
	TrustedAgentsConfig,
	TransportProvider,
} from "trusted-agents-core";

export interface CliContext {
	config: TrustedAgentsConfig;
	trustStore: ITrustStore;
	resolver: IAgentResolver;
}

export interface CliContextWithTransport extends CliContext {
	transport: TransportProvider;
}

function createViemClient(rpcUrl: string): PublicClient {
	return createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
}

export function buildContext(config: TrustedAgentsConfig): CliContext {
	const trustStore = new FileTrustStore(config.dataDir);
	const resolver = new AgentResolver(config.chains, createViemClient, {
		maxCacheEntries: config.resolveCacheMaxEntries,
	});

	return { config, trustStore, resolver };
}

export function buildContextWithTransport(config: TrustedAgentsConfig): CliContextWithTransport {
	const ctx = buildContext(config);

	const transport = new XmtpTransport(
		{
			privateKey: config.privateKey,
			chain: config.chain,
			env: config.xmtpEnv,
			dbEncryptionKey: config.xmtpDbEncryptionKey,
			agentResolver: ctx.resolver,
			resolveCacheTtlMs: config.resolveCacheTtlMs,
		},
		ctx.trustStore,
	);

	return { ...ctx, transport };
}
