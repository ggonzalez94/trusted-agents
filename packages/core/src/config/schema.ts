import { ConfigError } from "../common/errors.js";
import { resolveDataDir } from "../common/paths.js";
import { isCAIP2Chain } from "../common/validation.js";
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

	if (!/^0x[0-9a-fA-F]{64}$/.test(partial.privateKey)) {
		throw new ConfigError("privateKey must be a 32-byte hex string prefixed with 0x");
	}

	const mergedChains = {
		...DEFAULT_CONFIG.chains,
		...partial.chains,
	};

	for (const [name, chainConfig] of Object.entries(mergedChains)) {
		if (!chainConfig.registryAddress || /^0x0{40}$/i.test(chainConfig.registryAddress)) {
			throw new ConfigError(
				`Chain ${name} has an invalid registryAddress. Configure a deployed ERC-8004 registry address.`,
			);
		}
	}

	return {
		...DEFAULT_CONFIG,
		...partial,
		dataDir: resolveDataDir(partial.dataDir ?? DEFAULT_CONFIG.dataDir),
		chains: mergedChains,
	};
}
