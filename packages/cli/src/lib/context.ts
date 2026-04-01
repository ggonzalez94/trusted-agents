import {
	AgentResolver,
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	TapAppRegistry,
	XmtpTransport,
} from "trusted-agents-core";
import type {
	ChainConfig,
	IAgentResolver,
	ICalendarProvider,
	IConversationLogger,
	IRequestJournal,
	ITrustStore,
	SigningProvider,
	TransportProvider,
	TrustedAgentsConfig,
} from "trusted-agents-core";
import { buildChainPublicClient } from "trusted-agents-core";
import { resolveConfiguredCalendarProvider } from "./calendar/setup.js";
import { getCliRuntimeOverride } from "./runtime-overrides.js";
import { createConfiguredSigningProvider } from "./wallet-config.js";

export interface CliContext {
	config: TrustedAgentsConfig;
	signingProvider: SigningProvider;
	trustStore: ITrustStore;
	resolver: IAgentResolver;
	conversationLogger: IConversationLogger;
	requestJournal: IRequestJournal;
	appRegistry: TapAppRegistry;
	calendarProvider?: ICalendarProvider;
}

export interface CliContextWithTransport extends CliContext {
	transport: TransportProvider;
}

function createViemClient(chainConfig: ChainConfig) {
	return buildChainPublicClient(chainConfig);
}

function createLazySigningProvider(config: TrustedAgentsConfig): SigningProvider {
	let cached: SigningProvider | undefined;
	return new Proxy({} as SigningProvider, {
		get(_target, prop, receiver) {
			if (!cached) {
				cached = createConfiguredSigningProvider(config);
			}
			const value = Reflect.get(cached, prop, receiver);
			return typeof value === "function" ? value.bind(cached) : value;
		},
	});
}

export function buildContext(config: TrustedAgentsConfig): CliContext {
	const override = getCliRuntimeOverride(config.dataDir);
	const signingProvider = createLazySigningProvider(config);
	if (override?.createContext) {
		const overrideContext = override.createContext(config);
		return {
			config,
			signingProvider,
			appRegistry: new TapAppRegistry(config.dataDir),
			...overrideContext,
		};
	}

	const trustStore = new FileTrustStore(config.dataDir);
	const resolver = new AgentResolver(config.chains, createViemClient, {
		maxCacheEntries: config.resolveCacheMaxEntries,
	});
	const conversationLogger = new FileConversationLogger(config.dataDir);
	const requestJournal = new FileRequestJournal(config.dataDir);
	const appRegistry = new TapAppRegistry(config.dataDir);

	const calendarProvider = resolveCalendarProvider(config.dataDir);

	return {
		config,
		signingProvider,
		trustStore,
		resolver,
		conversationLogger,
		requestJournal,
		appRegistry,
		calendarProvider,
	};
}

export function buildContextWithTransport(config: TrustedAgentsConfig): CliContextWithTransport {
	const ctx = buildContext(config);
	const override = getCliRuntimeOverride(config.dataDir);

	if (override?.createTransport) {
		return { ...ctx, transport: override.createTransport(config, ctx) };
	}

	const transport = new XmtpTransport(
		{
			signingProvider: ctx.signingProvider,
			chain: config.chain,
			dbPath: `${config.dataDir}/xmtp`,
			dbEncryptionKey: config.xmtpDbEncryptionKey,
			agentResolver: ctx.resolver,
			resolveCacheTtlMs: config.resolveCacheTtlMs,
		},
		ctx.trustStore,
	);

	return { ...ctx, transport };
}

function resolveCalendarProvider(dataDir: string): ICalendarProvider | undefined {
	return resolveConfiguredCalendarProvider(dataDir);
}
