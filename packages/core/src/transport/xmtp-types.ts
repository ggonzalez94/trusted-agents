import type { IAgentResolver } from "../identity/resolver.js";

export interface XmtpTransportConfig {
	privateKey: `0x${string}`;
	chain: string;
	env?: "dev" | "production" | "local";
	dbPath?: string;
	syncStatePath?: string;
	dbEncryptionKey?: `0x${string}`;
	defaultResponseTimeoutMs?: number;
	agentResolver?: IAgentResolver;
	resolveCacheTtlMs?: number;
}
