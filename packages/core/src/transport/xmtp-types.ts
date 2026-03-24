import type { TrustedAgentsAccount } from "../config/types.js";
import type { IAgentResolver } from "../identity/resolver.js";

export interface XmtpTransportConfig {
	account: TrustedAgentsAccount;
	chain: string;
	env?: "dev" | "production" | "local";
	dbPath?: string;
	syncStatePath?: string;
	dbEncryptionKey?: `0x${string}`;
	defaultResponseTimeoutMs?: number;
	agentResolver?: IAgentResolver;
	resolveCacheTtlMs?: number;
}
