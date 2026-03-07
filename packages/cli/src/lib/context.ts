import {
	AgentResolver,
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	XmtpTransport,
} from "trusted-agents-core";
import type {
	ChainConfig,
	IAgentResolver,
	IConversationLogger,
	IRequestJournal,
	ITrustStore,
	TransportProvider,
	TrustedAgentsConfig,
} from "trusted-agents-core";
import { buildChainPublicClient } from "trusted-agents-core";
import { getCliRuntimeOverride } from "./runtime-overrides.js";

export interface CliContext {
	config: TrustedAgentsConfig;
	trustStore: ITrustStore;
	resolver: IAgentResolver;
	conversationLogger: IConversationLogger;
	requestJournal: IRequestJournal;
}

export interface CliContextWithTransport extends CliContext {
	transport: TransportProvider;
}

function createViemClient(chainConfig: ChainConfig) {
	return buildChainPublicClient(chainConfig);
}

export function buildContext(config: TrustedAgentsConfig): CliContext {
	const override = getCliRuntimeOverride(config.dataDir);
	if (override?.createContext) {
		return { config, ...override.createContext(config) };
	}

	const trustStore = new FileTrustStore(config.dataDir);
	const resolver = new AgentResolver(config.chains, createViemClient, {
		maxCacheEntries: config.resolveCacheMaxEntries,
	});
	const conversationLogger = new FileConversationLogger(config.dataDir);
	const requestJournal = new FileRequestJournal(config.dataDir);

	return { config, trustStore, resolver, conversationLogger, requestJournal };
}

export function buildContextWithTransport(config: TrustedAgentsConfig): CliContextWithTransport {
	const ctx = buildContext(config);
	const override = getCliRuntimeOverride(config.dataDir);

	if (override?.createTransport) {
		return { ...ctx, transport: override.createTransport(config, ctx) };
	}

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
