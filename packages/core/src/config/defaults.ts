import { homedir } from "node:os";
import type { ChainConfig, TrustedAgentsConfig } from "./types.js";

export const BASE_MAINNET: ChainConfig = {
	chainId: 8453,
	caip2: "eip155:8453",
	name: "Base",
	rpcUrl: "https://mainnet.base.org",
	registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
	blockExplorerUrl: "https://basescan.org",
};

export const BASE_SEPOLIA: ChainConfig = {
	chainId: 84532,
	caip2: "eip155:84532",
	name: "Base Sepolia",
	rpcUrl: "https://sepolia.base.org",
	// ERC-8004 uses deterministic CREATE2 deployment; override if your test deployment differs.
	registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
	blockExplorerUrl: "https://sepolia.basescan.org",
};

export const DEFAULT_CHAINS: Record<string, ChainConfig> = {
	"eip155:8453": BASE_MAINNET,
	"eip155:84532": BASE_SEPOLIA,
};

export const DEFAULT_CONFIG: Omit<TrustedAgentsConfig, "agentId" | "chain" | "privateKey"> = {
	dataDir: `${homedir()}/.trustedagents`,
	port: 3000,
	host: "0.0.0.0",
	chains: DEFAULT_CHAINS,
	inviteExpirySeconds: 86400, // 24 hours
	resolveCacheTtlMs: 86400000, // 24 hours
	resolveCacheMaxEntries: 1000,
};
