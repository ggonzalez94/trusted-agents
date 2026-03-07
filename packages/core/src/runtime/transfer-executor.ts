import {
	http,
	createPublicClient,
	createWalletClient,
	defineChain,
	parseEther,
	parseUnits,
} from "viem";
import type { Chain, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, taiko, taikoHoodi } from "viem/chains";
import { ValidationError } from "../common/index.js";
import type { TrustedAgentsConfig } from "../config/types.js";
import type { TransferActionRequest } from "./actions.js";

const ERC20_TRANSFER_ABI = [
	{
		type: "function",
		name: "transfer",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "success", type: "bool" }],
	},
] as const;

const VIEM_CHAINS: Record<number, Chain> = {
	8453: base,
	84532: baseSepolia,
	167000: taiko,
	167013: taikoHoodi,
};

const USDC_BY_CHAIN: Record<
	string,
	{
		address: `0x${string}`;
		decimals: number;
	}
> = {
	"eip155:8453": {
		address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		decimals: 6,
	},
	"eip155:84532": {
		address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		decimals: 6,
	},
	"eip155:167000": {
		address: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
		decimals: 6,
	},
	"eip155:167013": {
		address: "0xf501925c8FE6c5B2FC8faD86b8C9acb2596f3295",
		decimals: 6,
	},
};

export async function executeOnchainTransfer(
	config: TrustedAgentsConfig,
	request: TransferActionRequest,
): Promise<{ txHash: `0x${string}` }> {
	const chainConfig = config.chains[request.chain];
	if (!chainConfig) {
		throw new ValidationError(`Unsupported chain for transfer: ${request.chain}`);
	}

	const account = privateKeyToAccount(config.privateKey);
	const walletClient = buildWalletClient(config.privateKey, chainConfig);
	const publicClient = buildPublicClient(chainConfig);

	if (request.asset === "native") {
		const txHash = await walletClient.sendTransaction({
			account,
			chain: walletClient.chain,
			to: request.toAddress,
			value: parseEther(request.amount),
		});
		await publicClient.waitForTransactionReceipt({ hash: txHash });
		return { txHash };
	}

	const usdc = USDC_BY_CHAIN[request.chain];
	if (!usdc) {
		throw new ValidationError(`USDC is not supported on ${request.chain}`);
	}

	const txHash = await walletClient.writeContract({
		account,
		chain: walletClient.chain,
		address: usdc.address,
		abi: ERC20_TRANSFER_ABI,
		functionName: "transfer",
		args: [request.toAddress, parseUnits(request.amount, usdc.decimals)],
	});
	await publicClient.waitForTransactionReceipt({ hash: txHash });
	return { txHash };
}

function buildWalletClient(
	privateKey: `0x${string}`,
	chainConfig: TrustedAgentsConfig["chains"][string],
): WalletClient {
	const account = privateKeyToAccount(privateKey);
	const chain = getViemChain(chainConfig);

	return createWalletClient({
		account,
		chain,
		transport: http(chainConfig.rpcUrl),
	});
}

function buildPublicClient(chainConfig: TrustedAgentsConfig["chains"][string]): PublicClient {
	const chain = getViemChain(chainConfig);
	return createPublicClient({
		chain,
		transport: http(chainConfig.rpcUrl),
	}) as PublicClient;
}

function getViemChain(chainConfig: TrustedAgentsConfig["chains"][string]): Chain {
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
