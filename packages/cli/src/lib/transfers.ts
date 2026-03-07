import { ValidationError } from "trusted-agents-core";
import type { TrustedAgentsConfig } from "trusted-agents-core";
import { parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TransferActionRequest } from "./actions.js";
import { getUsdcAsset } from "./assets.js";
import { getCliRuntimeOverride } from "./runtime-overrides.js";
import { buildPublicClient, buildWalletClient } from "./wallet.js";

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

export async function executeTransferAction(
	config: TrustedAgentsConfig,
	request: TransferActionRequest,
): Promise<{ txHash: `0x${string}` }> {
	const override = getCliRuntimeOverride(config.dataDir);
	if (override?.executeTransferAction) {
		return await override.executeTransferAction(config, request);
	}

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

	const usdc = getUsdcAsset(request.chain);
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
