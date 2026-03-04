import type { ChainConfig } from "trusted-agents-core";
import { BASE_MAINNET, BASE_SEPOLIA } from "trusted-agents-core";

/**
 * Additional chain configs beyond what core provides.
 * Core has Base + Base Sepolia; we add Taiko chains here.
 */
export const TAIKO_MAINNET: ChainConfig = {
	chainId: 167000,
	caip2: "eip155:167000",
	name: "Taiko",
	rpcUrl: "https://rpc.mainnet.taiko.xyz",
	registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
	blockExplorerUrl: "https://taikoscan.io",
};

export const TAIKO_HOODI: ChainConfig = {
	chainId: 167013,
	caip2: "eip155:167013",
	name: "Taiko Hoodi",
	rpcUrl: "https://rpc.hoodi.taiko.xyz",
	// Testnet registries use a different address than mainnet.
	registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
	blockExplorerUrl: "https://hoodi.taikoscan.io",
};

/** All known chain configs, keyed by CAIP-2 ID. */
export const ALL_CHAINS: Record<string, ChainConfig> = {
	"eip155:8453": BASE_MAINNET,
	"eip155:84532": BASE_SEPOLIA,
	"eip155:167000": TAIKO_MAINNET,
	"eip155:167013": TAIKO_HOODI,
};

/**
 * Human-friendly aliases → CAIP-2 chain IDs.
 * Accepts multiple spellings for convenience.
 */
const CHAIN_ALIASES: Record<string, string> = {
	// Base
	"base": "eip155:8453",
	"base-mainnet": "eip155:8453",
	// Base Sepolia
	"base-sepolia": "eip155:84532",
	"basesepolia": "eip155:84532",
	// Taiko
	"taiko": "eip155:167000",
	"taiko-mainnet": "eip155:167000",
	// Taiko Hoodi
	"taiko-hoodi": "eip155:167013",
	"taikohoodi": "eip155:167013",
	"hoodi": "eip155:167013",
};

/**
 * Resolve a chain identifier to a CAIP-2 ID.
 * Accepts: alias ("base-sepolia"), CAIP-2 ("eip155:84532"), or bare chain ID ("84532").
 */
export function resolveChainAlias(input: string): string {
	const lower = input.toLowerCase().trim();

	// 1. Exact alias match
	if (CHAIN_ALIASES[lower]) {
		return CHAIN_ALIASES[lower];
	}

	// 2. Already a CAIP-2 ID
	if (lower.startsWith("eip155:")) {
		return lower;
	}

	// 3. Bare numeric chain ID
	const num = Number.parseInt(lower, 10);
	if (!Number.isNaN(num)) {
		return `eip155:${num}`;
	}

	// 4. Unknown — return as-is, let config validation catch it
	return input;
}

/** List all known aliases for help text. */
export function chainAliasHelpText(): string {
	return [
		"  base-sepolia   Base Sepolia testnet (default)",
		"  base           Base mainnet",
		"  taiko          Taiko mainnet",
		"  taiko-hoodi    Taiko Hoodi testnet",
		"  eip155:<id>    Any chain by CAIP-2 ID",
	].join("\n");
}
