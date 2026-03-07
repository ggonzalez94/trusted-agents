import { http, createPublicClient } from "viem";
import type { PublicClient } from "viem";
import type { TrustedAgentsConfig } from "../config/types.js";
import { FileConversationLogger, type IConversationLogger } from "../conversation/logger.js";
import { AgentResolver, type IAgentResolver } from "../identity/resolver.js";
import type { TransportProvider } from "../transport/interface.js";
import { XmtpTransport } from "../transport/xmtp.js";
import { FileTrustStore } from "../trust/file-trust-store.js";
import type { ITrustStore } from "../trust/trust-store.js";
import { FileRequestJournal, type IRequestJournal } from "./request-journal.js";

export interface TapRuntimeContext {
	config: TrustedAgentsConfig;
	trustStore: ITrustStore;
	resolver: IAgentResolver;
	conversationLogger: IConversationLogger;
	requestJournal: IRequestJournal;
	transport: TransportProvider;
}

export interface BuildTapRuntimeContextOptions {
	trustStore?: ITrustStore;
	resolver?: IAgentResolver;
	conversationLogger?: IConversationLogger;
	requestJournal?: IRequestJournal;
	transport?: TransportProvider;
}

function createViemClient(rpcUrl: string): PublicClient {
	return createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
}

export function buildDefaultTapRuntimeContext(
	config: TrustedAgentsConfig,
	options: BuildTapRuntimeContextOptions = {},
): TapRuntimeContext {
	const trustStore = options.trustStore ?? new FileTrustStore(config.dataDir);
	const resolver =
		options.resolver ??
		new AgentResolver(config.chains, createViemClient, {
			maxCacheEntries: config.resolveCacheMaxEntries,
		});
	const conversationLogger =
		options.conversationLogger ?? new FileConversationLogger(config.dataDir);
	const requestJournal = options.requestJournal ?? new FileRequestJournal(config.dataDir);
	const transport =
		options.transport ??
		new XmtpTransport(
			{
				privateKey: config.privateKey,
				chain: config.chain,
				env: config.xmtpEnv,
				dbEncryptionKey: config.xmtpDbEncryptionKey,
				agentResolver: resolver,
				resolveCacheTtlMs: config.resolveCacheTtlMs,
			},
			trustStore,
		);

	return {
		config,
		trustStore,
		resolver,
		conversationLogger,
		requestJournal,
		transport,
	};
}
