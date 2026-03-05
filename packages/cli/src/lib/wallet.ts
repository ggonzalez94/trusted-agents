import { createWalletClient, http, createPublicClient, defineChain } from "viem";
import type { WalletClient, PublicClient, Chain } from "viem";
import { base, baseSepolia, taiko, taikoHoodi } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainConfig } from "trusted-agents-core";

const VIEM_CHAINS: Record<number, Chain> = {
	8453: base,
	84532: baseSepolia,
	167000: taiko,
	167013: taikoHoodi,
};

function getViemChain(chainConfig: ChainConfig): Chain {
	return VIEM_CHAINS[chainConfig.chainId] ?? defineChain({
		id: chainConfig.chainId,
		name: chainConfig.name,
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: { default: { http: [chainConfig.rpcUrl] } },
	});
}

export function buildWalletClient(
	privateKey: `0x${string}`,
	chainConfig: ChainConfig,
): WalletClient {
	const account = privateKeyToAccount(privateKey);
	const chain = getViemChain(chainConfig);

	return createWalletClient({
		account,
		chain,
		transport: http(chainConfig.rpcUrl),
	});
}

export function buildPublicClient(chainConfig: ChainConfig): PublicClient {
	const chain = getViemChain(chainConfig);
	return createPublicClient({
		chain,
		transport: http(chainConfig.rpcUrl),
	}) as PublicClient;
}
