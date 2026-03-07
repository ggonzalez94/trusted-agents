import {
	type ChainConfig,
	buildChainPublicClient as buildCorePublicClient,
	buildChainWalletClient as buildCoreWalletClient,
} from "trusted-agents-core";
import type { PublicClient, WalletClient } from "viem";

export function buildWalletClient(
	privateKey: `0x${string}`,
	chainConfig: ChainConfig,
): WalletClient {
	return buildCoreWalletClient(privateKey, chainConfig);
}

export function buildPublicClient(chainConfig: ChainConfig): PublicClient {
	return buildCorePublicClient(chainConfig);
}
