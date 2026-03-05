import {
	AgentResolver,
	FileConversationLogger,
	FileTrustStore,
	XmtpTransport,
} from "trusted-agents-core";
import type {
	IAgentResolver,
	IConversationLogger,
	ITrustStore,
	TransportProvider,
	TrustedAgentsConfig,
} from "trusted-agents-core";
import { http, createPublicClient } from "viem";
import type { PublicClient } from "viem";

export interface CliContext {
	config: TrustedAgentsConfig;
	trustStore: ITrustStore;
	resolver: IAgentResolver;
	conversationLogger: IConversationLogger;
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
	const conversationLogger = new FileConversationLogger(config.dataDir);

	return { config, trustStore, resolver, conversationLogger };
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
