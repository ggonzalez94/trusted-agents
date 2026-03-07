import { encodeFunctionData, parseEther, parseUnits } from "viem";
import { ValidationError } from "../common/index.js";
import type { TrustedAgentsConfig } from "../config/types.js";
import type { TransferActionRequest } from "./actions.js";
import { getUsdcAsset } from "./assets.js";
import { executeContractCalls } from "./execution.js";

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

export async function executeOnchainTransfer(
	config: TrustedAgentsConfig,
	request: TransferActionRequest,
): Promise<{ txHash: `0x${string}` }> {
	const chainConfig = config.chains[request.chain];
	if (!chainConfig) {
		throw new ValidationError(`Unsupported chain for transfer: ${request.chain}`);
	}

	if (request.asset === "native") {
		const result = await executeContractCalls(config, chainConfig, [
			{
				to: request.toAddress,
				data: "0x",
				value: parseEther(request.amount),
			},
		]);
		return { txHash: result.transactionHash };
	}

	const usdc = getUsdcAsset(request.chain);
	if (!usdc) {
		throw new ValidationError(`USDC is not supported on ${request.chain}`);
	}

	const result = await executeContractCalls(config, chainConfig, [
		{
			to: usdc.address,
			data: encodeFunctionData({
				abi: ERC20_TRANSFER_ABI,
				functionName: "transfer",
				args: [request.toAddress, parseUnits(request.amount, usdc.decimals)],
			}),
		},
	]);

	return { txHash: result.transactionHash };
}
