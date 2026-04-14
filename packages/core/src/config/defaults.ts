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

export const TAIKO_MAINNET: ChainConfig = {
	chainId: 167000,
	caip2: "eip155:167000",
	name: "Taiko",
	rpcUrl: "https://rpc.mainnet.taiko.xyz",
	registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
	blockExplorerUrl: "https://taikoscan.io",
};

/**
 * All chain configs TAP ships with. Every process that constructs a
 * `TrustedAgentsConfig` (CLI, tapd, SDK embedders) should pass this as
 * `extraChains` to `loadTrustedAgentConfigFromDataDir` so a single source of
 * truth governs which chains TAP supports. See `Agents.md` for the rule that
 * adding a chain requires updating this map.
 */
export const ALL_CHAINS: Record<string, ChainConfig> = {
	[BASE_MAINNET.caip2]: BASE_MAINNET,
	[TAIKO_MAINNET.caip2]: TAIKO_MAINNET,
};

export const DEFAULT_CONFIG: Omit<TrustedAgentsConfig, "agentId" | "chain" | "ows"> = {
	dataDir: `${homedir()}/.trustedagents`,
	chains: { "eip155:8453": BASE_MAINNET },
	inviteExpirySeconds: 86400, // 24 hours
	resolveCacheTtlMs: 86400000, // 24 hours
	resolveCacheMaxEntries: 1000,
	ipfs: {
		provider: "auto",
	},
	execution: {
		mode: "eip7702",
		paymasterProvider: "circle",
	},
};
