import type { ChainConfig, TrustedAgentsConfig } from "./types.js";

export const BASE_MAINNET: ChainConfig = {
	chainId: 8453,
	caip2: "eip155:8453",
	name: "Base",
	rpcUrl: "https://mainnet.base.org",
	registryAddress: "0x0000000000000000000000000000000000000000",
	blockExplorerUrl: "https://basescan.org",
};

export const BASE_SEPOLIA: ChainConfig = {
	chainId: 84532,
	caip2: "eip155:84532",
	name: "Base Sepolia",
	rpcUrl: "https://sepolia.base.org",
	registryAddress: "0x0000000000000000000000000000000000000000",
	blockExplorerUrl: "https://sepolia.basescan.org",
};

export const DEFAULT_CHAINS: Record<string, ChainConfig> = {
	"eip155:8453": BASE_MAINNET,
	"eip155:84532": BASE_SEPOLIA,
};

export const DEFAULT_CONFIG: Omit<TrustedAgentsConfig, "agentId" | "chain" | "privateKey"> = {
	dataDir: "~/.trustedagents",
	port: 3000,
	host: "0.0.0.0",
	chains: DEFAULT_CHAINS,
	inviteExpirySeconds: 86400, // 24 hours
	resolveCacheTtlMs: 86400000, // 24 hours
};
