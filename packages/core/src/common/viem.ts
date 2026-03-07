import { http, createPublicClient, createWalletClient, defineChain, fallback } from "viem";
import type { Chain, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, taiko, taikoHoodi } from "viem/chains";
import type { ChainConfig } from "../config/types.js";

const VIEM_CHAINS: Record<number, Chain> = {
	8453: base,
	84532: baseSepolia,
	167000: taiko,
	167013: taikoHoodi,
};

const RPC_TIMEOUT_MS = 15_000;
const RPC_RETRY_COUNT = 3;
const RPC_RETRY_DELAY_MS = 300;
const RPC_FALLBACK_URLS: Partial<Record<number, string[]>> = {
	8453: ["https://mainnet-preconf.base.org"],
	84532: ["https://sepolia-preconf.base.org"],
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
	privateKey: `0x${string}`,
	chainConfig: ChainConfig,
): WalletClient {
	const account = privateKeyToAccount(privateKey);
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
