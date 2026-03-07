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
	// Testnet registries use a different address than mainnet.
	// See https://github.com/erc-8004/erc-8004-contracts
	registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
	blockExplorerUrl: "https://sepolia.basescan.org",
};

export const DEFAULT_CHAINS: Record<string, ChainConfig> = {
	"eip155:8453": BASE_MAINNET,
	"eip155:84532": BASE_SEPOLIA,
};

export const DEFAULT_CONFIG: Omit<TrustedAgentsConfig, "agentId" | "chain" | "privateKey"> = {
	dataDir: `${homedir()}/.trustedagents`,
	chains: DEFAULT_CHAINS,
	inviteExpirySeconds: 86400, // 24 hours
	resolveCacheTtlMs: 86400000, // 24 hours
	resolveCacheMaxEntries: 1000,
	xmtpEnv: "production",
	execution: {
		mode: "eip7702",
		paymasterProvider: "circle",
	},
};
