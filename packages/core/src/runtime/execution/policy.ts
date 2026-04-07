import { DEFAULT_CONFIG } from "../../config/defaults.js";
import {
	getDefaultExecutionModeForChain,
	getDefaultPaymasterProviderForMode,
} from "../../config/load.js";
import type {
	ChainConfig,
	ExecutionMode,
	ExecutionPaymasterProvider,
	TrustedAgentsConfig,
} from "../../config/types.js";
import type { ResolvedExecutionMode } from "./types.js";

function isBaseChain(chainConfig: ChainConfig): boolean {
	return chainConfig.chainId === 8453;
}

function isTaikoMainnetChain(chainConfig: ChainConfig): boolean {
	return chainConfig.chainId === 167000;
}

export function requestedExecutionMode(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
): ExecutionMode {
	return config.execution?.mode ?? getDefaultExecutionModeForChain(chainConfig.caip2);
}

export function resolveExecutionMode(
	chainConfig: ChainConfig,
	requestedMode: ExecutionMode,
	warnings: string[],
): ResolvedExecutionMode {
	if (requestedMode === "eoa") {
		return "eoa";
	}

	if (requestedMode === "eip4337") {
		if (isTaikoMainnetChain(chainConfig)) {
			return "eip4337";
		}

		if (isBaseChain(chainConfig)) {
			warnings.push(
				`${chainConfig.name} uses EIP-7702 as the default account-abstraction path in this runtime; using eip7702`,
			);
			return "eip7702";
		}

		warnings.push(
			`${chainConfig.name} does not have a zero-config account-abstraction path in this runtime yet; using eoa`,
		);
		return "eoa";
	}

	if (isBaseChain(chainConfig)) {
		return "eip7702";
	}

	if (isTaikoMainnetChain(chainConfig)) {
		warnings.push(
			`${chainConfig.name} uses EIP-4337 as the account-abstraction path in this runtime; using eip4337`,
		);
		return "eip4337";
	}

	warnings.push(
		`${chainConfig.name} does not have a zero-config account-abstraction path in this runtime yet; using eoa`,
	);
	return "eoa";
}

function isPaymasterProviderCompatible(
	mode: "eip4337" | "eip7702",
	provider: ExecutionPaymasterProvider,
): boolean {
	if (mode === "eip4337") {
		return provider === "servo";
	}

	return provider === "circle" || provider === "candide";
}

export function resolvePaymasterProvider(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	mode: "eip4337" | "eip7702",
	warnings: string[],
): ExecutionPaymasterProvider {
	const configuredProvider = config.execution?.paymasterProvider;
	const defaultProvider =
		getDefaultPaymasterProviderForMode(mode) ??
		DEFAULT_CONFIG.execution?.paymasterProvider ??
		"circle";

	if (!configuredProvider || isPaymasterProviderCompatible(mode, configuredProvider)) {
		return configuredProvider ?? defaultProvider;
	}

	warnings.push(
		`${configuredProvider} is not available for ${mode} execution on ${chainConfig.name}; using ${defaultProvider}`,
	);
	return defaultProvider;
}
