import {
	type ChainConfig,
	type TrustedAgentsAccount,
	buildChainPublicClient as buildCorePublicClient,
	buildChainWalletClient as buildCoreWalletClient,
} from "trusted-agents-core";
import type { PublicClient, WalletClient } from "viem";

export function buildWalletClient(
	account: TrustedAgentsAccount,
	chainConfig: ChainConfig,
): WalletClient {
	return buildCoreWalletClient(account, chainConfig);
}

export function buildPublicClient(chainConfig: ChainConfig): PublicClient {
	return buildCorePublicClient(chainConfig);
}
