export interface ChainConfig {
	chainId: number;
	caip2: string;
	name: string;
	rpcUrl: string;
	registryAddress: `0x${string}`;
	blockExplorerUrl?: string;
}

export type ExecutionMode = "eoa" | "eip4337" | "eip7702";
export type ExecutionPaymasterProvider = "circle" | "candide" | "servo";
export type IpfsUploadProvider = "auto" | "x402" | "pinata" | "tack";

export interface ExecutionConfig {
	mode?: ExecutionMode;
	paymasterProvider?: ExecutionPaymasterProvider;
}

export interface IpfsConfig {
	provider?: IpfsUploadProvider;
	tackApiUrl?: string;
}

export interface OwsConfig {
	wallet: string;
	apiKey: string;
}

export interface TrustedAgentsConfig {
	agentId: number;
	chain: string;
	ows: OwsConfig;
	dataDir: string;
	chains: Record<string, ChainConfig>;
	inviteExpirySeconds: number;
	resolveCacheTtlMs: number;
	resolveCacheMaxEntries: number;
	xmtpDbPath?: string;
	xmtpDbEncryptionKey?: `0x${string}`;
	execution?: ExecutionConfig;
	ipfs?: IpfsConfig;
}
