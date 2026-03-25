import { http, createPublicClient, createWalletClient, defineChain, fallback } from "viem";
import type { Chain, LocalAccount, PublicClient, WalletClient } from "viem";
import { base, taiko } from "viem/chains";
import type { ChainConfig } from "../config/types.js";

const VIEM_CHAINS: Record<number, Chain> = {
	8453: base,
	167000: taiko,
};

const RPC_TIMEOUT_MS = 15_000;
const RPC_RETRY_COUNT = 3;
const RPC_RETRY_DELAY_MS = 300;
const RPC_FALLBACK_URLS: Partial<Record<number, string[]>> = {
	8453: [
		"https://base-rpc.publicnode.com",
		"https://base.drpc.org",
		"https://base.llamarpc.com",
		"https://mainnet-preconf.base.org",
	],
};

export function getViemChain(chainConfig: ChainConfig): Chain {
	return (
		VIEM_CHAINS[chainConfig.chainId] ??
		defineChain({
			id: chainConfig.chainId,
			name: chainConfig.name,
			nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
			rpcUrls: { default: { http: [chainConfig.rpcUrl] } },
		})
	);
}

export function buildChainTransport(chainConfig: ChainConfig) {
	const urls = [
		chainConfig.rpcUrl,
		...(RPC_FALLBACK_URLS[chainConfig.chainId] ?? []).filter((url) => url !== chainConfig.rpcUrl),
	];
	const transports = urls.map((url) =>
		http(url, {
			timeout: RPC_TIMEOUT_MS,
			retryCount: RPC_RETRY_COUNT,
			retryDelay: RPC_RETRY_DELAY_MS,
		}),
	);

	return transports.length === 1 ? transports[0]! : fallback(transports);
}

export function buildChainWalletClient(
	account: LocalAccount,
	chainConfig: ChainConfig,
): WalletClient {
	return createWalletClient({
		account,
		chain: getViemChain(chainConfig),
		transport: buildChainTransport(chainConfig),
	});
}

export function buildChainPublicClient(chainConfig: ChainConfig): PublicClient {
	return createPublicClient({
		chain: getViemChain(chainConfig),
		transport: buildChainTransport(chainConfig),
	}) as PublicClient;
}
