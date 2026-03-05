export interface ChainConfig {
	chainId: number;
	caip2: string;
	name: string;
	rpcUrl: string;
	registryAddress: `0x${string}`;
	blockExplorerUrl?: string;
}

export interface TrustedAgentsConfig {
	agentId: number;
	chain: string;
	privateKey: `0x${string}`;
	dataDir: string;
	chains: Record<string, ChainConfig>;
	inviteExpirySeconds: number;
	resolveCacheTtlMs: number;
	resolveCacheMaxEntries: number;
	xmtpEnv?: "dev" | "production" | "local";
	xmtpDbPath?: string;
	xmtpDbEncryptionKey?: `0x${string}`;
}
