import { ConfigError } from "../common/errors.js";
import { isCAIP2Chain, isEthereumAddress } from "../common/validation.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import type { TrustedAgentsConfig } from "./types.js";

export function validateConfig(
	partial: Partial<TrustedAgentsConfig> &
		Pick<TrustedAgentsConfig, "agentId" | "chain" | "privateKey">,
): TrustedAgentsConfig {
	if (typeof partial.agentId !== "number" || partial.agentId < 0) {
		throw new ConfigError("agentId must be a non-negative number");
	}

	if (!isCAIP2Chain(partial.chain)) {
		throw new ConfigError(
			`Invalid chain format: ${partial.chain}. Expected CAIP-2 (e.g. eip155:8453)`,
		);
	}

	if (!partial.privateKey || !isEthereumAddress(partial.privateKey.slice(0, 42) as string)) {
		// Basic check: privateKey should be a hex string
		if (!/^0x[0-9a-fA-F]{64}$/.test(partial.privateKey)) {
			throw new ConfigError("privateKey must be a 32-byte hex string prefixed with 0x");
		}
	}

	return {
		...DEFAULT_CONFIG,
		...partial,
		chains: {
			...DEFAULT_CONFIG.chains,
			...partial.chains,
		},
	};
}
