import type { ChainConfig, TrustedAgentsConfig } from "trusted-agents-core";
import { ALL_CHAINS, ValidationError } from "trusted-agents-core";

// Chain definitions live in core (see `packages/core/src/config/defaults.ts`)
// so tapd, the SDK, and the CLI all use the same source of truth.
export { ALL_CHAINS };

export const DEFAULT_CHAIN_ALIAS = "base" as const;

/**
 * Human-friendly aliases → CAIP-2 chain IDs.
 * Accepts multiple spellings for convenience.
 */
const CHAIN_ALIASES: Record<string, string> = {
	// Base
	base: "eip155:8453",
	"base-mainnet": "eip155:8453",
	// Taiko
	taiko: "eip155:167000",
	"taiko-mainnet": "eip155:167000",
};

/**
 * Resolve a chain identifier to a CAIP-2 ID.
 * Accepts: alias ("base"), CAIP-2 ("eip155:8453"), or bare chain ID ("8453").
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
		"  base           Base mainnet (default)",
		"  taiko          Taiko mainnet",
		"  eip155:<id>    Any chain by CAIP-2 ID",
	].join("\n");
}

/**
 * Resolve a chain from config and throw if the chain config is missing.
 * The rawInput parameter is included in the error message when provided (e.g. the original user input before alias resolution).
 */
export function requireChainConfig(
	config: TrustedAgentsConfig,
	chain: string,
	rawInput?: string,
): ChainConfig {
	const chainConfig = config.chains[chain];
	if (!chainConfig) {
		throw new ValidationError(
			`Unknown chain: ${rawInput ?? chain}. Use a supported alias like base/taiko or a CAIP-2 ID like eip155:8453.`,
		);
	}
	return chainConfig;
}
