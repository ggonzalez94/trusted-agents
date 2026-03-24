import type { PrivateKeyAccount } from "viem/accounts";

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

export interface OpenWalletConfig {
	provider: "open-wallet";
	name: string;
	id?: string;
	vaultPath?: string;
}

export interface EnvPrivateKeyWalletConfig {
	provider: "env-private-key";
}

export interface LegacyKeyfileWalletConfig {
	provider: "legacy-keyfile";
	path: string;
}

export type TrustedAgentsWalletConfig =
	| OpenWalletConfig
	| EnvPrivateKeyWalletConfig
	| LegacyKeyfileWalletConfig;

export type TrustedAgentsAccount = PrivateKeyAccount;

export interface TrustedAgentsConfig {
	agentId: number;
	chain: string;
	account: TrustedAgentsAccount;
	wallet: TrustedAgentsWalletConfig;
	dataDir: string;
	chains: Record<string, ChainConfig>;
	inviteExpirySeconds: number;
	resolveCacheTtlMs: number;
	resolveCacheMaxEntries: number;
	xmtpEnv?: "dev" | "production" | "local";
	xmtpDbPath?: string;
	xmtpDbEncryptionKey?: `0x${string}`;
	execution?: ExecutionConfig;
	ipfs?: IpfsConfig;
}
