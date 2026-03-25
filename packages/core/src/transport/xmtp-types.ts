import type { IAgentResolver } from "../identity/resolver.js";
import type { SigningProvider } from "../signing/provider.js";

export interface XmtpTransportConfig {
	signingProvider: SigningProvider;
	chain: string;
	dbPath?: string;
	syncStatePath?: string;
	dbEncryptionKey?: `0x${string}`;
	defaultResponseTimeoutMs?: number;
	agentResolver?: IAgentResolver;
	resolveCacheTtlMs?: number;
}
