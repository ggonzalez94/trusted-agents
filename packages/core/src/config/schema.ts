import { ConfigError } from "../common/errors.js";
import { resolveDataDir } from "../common/paths.js";
import { isCAIP2Chain } from "../common/validation.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import type { TrustedAgentsConfig } from "./types.js";

export function validateConfig(
	partial: Partial<TrustedAgentsConfig> & Pick<TrustedAgentsConfig, "agentId" | "chain" | "ows">,
): TrustedAgentsConfig {
	if (typeof partial.agentId !== "number" || partial.agentId < 0) {
		throw new ConfigError("agentId must be a non-negative number");
	}

	if (!isCAIP2Chain(partial.chain)) {
		throw new ConfigError(
			`Invalid chain format: ${partial.chain}. Expected CAIP-2 (e.g. eip155:8453)`,
		);
	}

	if (!partial.ows?.wallet || typeof partial.ows.wallet !== "string") {
		throw new ConfigError("ows.wallet is required and must be a non-empty string");
	}
	if (partial.ows?.passphrase !== undefined && typeof partial.ows.passphrase !== "string") {
		throw new ConfigError("ows.passphrase must be a string");
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

	if (
		partial.xmtpDbEncryptionKey !== undefined &&
		!/^0x[0-9a-fA-F]{64}$/.test(partial.xmtpDbEncryptionKey)
	) {
		throw new ConfigError("xmtpDbEncryptionKey must be a 32-byte hex string prefixed with 0x");
	}

	if (
		partial.execution?.mode !== undefined &&
		!["eoa", "eip4337", "eip7702"].includes(partial.execution.mode)
	) {
		throw new ConfigError("execution.mode must be eoa, eip4337, or eip7702");
	}

	if (
		partial.execution?.paymasterProvider !== undefined &&
		!["circle", "candide", "servo"].includes(partial.execution.paymasterProvider)
	) {
		throw new ConfigError("execution.paymasterProvider must be circle, candide, or servo");
	}

	if (
		partial.ipfs?.provider !== undefined &&
		!["auto", "x402", "pinata", "tack"].includes(partial.ipfs.provider)
	) {
		throw new ConfigError("ipfs.provider must be auto, x402, pinata, or tack");
	}

	if (partial.ipfs?.tackApiUrl !== undefined) {
		try {
			const parsed = new URL(partial.ipfs.tackApiUrl);
			if (!["http:", "https:"].includes(parsed.protocol)) {
				throw new Error("invalid protocol");
			}
		} catch {
			throw new ConfigError("ipfs.tackApiUrl must be a valid http(s) URL");
		}
	}

	return {
		...DEFAULT_CONFIG,
		...partial,
		dataDir: resolveDataDir(partial.dataDir ?? DEFAULT_CONFIG.dataDir),
		chains: mergedChains,
	};
}
