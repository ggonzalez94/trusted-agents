import {
	type ChainConfig,
	buildChainPublicClient as buildCorePublicClient,
	buildChainWalletClient as buildCoreWalletClient,
} from "trusted-agents-core";
import type { LocalAccount, PublicClient, WalletClient } from "viem";

export function buildWalletClient(account: LocalAccount, chainConfig: ChainConfig): WalletClient {
	return buildCoreWalletClient(account, chainConfig);
}

export function buildPublicClient(chainConfig: ChainConfig): PublicClient {
	return buildCorePublicClient(chainConfig);
}
