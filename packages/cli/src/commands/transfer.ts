import { randomUUID } from "node:crypto";
import {
	ERC20_TRANSFER_ABI,
	ValidationError,
	executeOnchainTransfer,
	isEthereumAddress,
} from "trusted-agents-core";
import type { ChainConfig } from "trusted-agents-core";
import { encodeFunctionData, getAddress, parseEther, parseUnits } from "viem";
import { getUsdcAsset, normalizeAsset } from "../lib/assets.js";
import { resolveChainAlias } from "../lib/chains.js";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { type ExecutionPreview, getExecutionPreview } from "../lib/execution.js";
import { error, success } from "../lib/output.js";
import { promptYesNo } from "../lib/prompt.js";
import { createConfiguredSigningProvider } from "../lib/wallet-config.js";
import { buildPublicClient } from "../lib/wallet.js";
import type { GlobalOptions } from "../types.js";

interface TransferCommandOptions {
	to: string;
	asset: string;
	amount: string;
	chain?: string;
	dryRun?: boolean;
	yes?: boolean;
}

interface TransferGasEstimate {
	gasUnits?: bigint;
	maxFeePerGasWei?: bigint;
	maxPriorityFeePerGasWei?: bigint;
	gasPriceWei?: bigint;
	warning?: string;
}

export async function transferCommand(
	cmdOpts: TransferCommandOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const chain = resolveChainAlias(cmdOpts.chain ?? config.chain);
		const chainConfig = config.chains[chain];
		if (!chainConfig) {
			error(
				"VALIDATION_ERROR",
				`Unknown chain: ${cmdOpts.chain ?? chain}. Use a supported alias like base/taiko or a CAIP-2 ID like eip155:8453.`,
				opts,
			);
			process.exitCode = 2;
			return;
		}

		const asset = normalizeAsset(cmdOpts.asset);
		const toAddress = normalizeRecipientAddress(cmdOpts.to);
		const amount = normalizeAmount(cmdOpts.amount);
		const usdcAsset = asset === "usdc" ? getUsdcAsset(chain) : undefined;
		if (asset === "usdc" && !usdcAsset) {
			throw new ValidationError(`USDC is not supported on ${chain}`);
		}
		assertAmountIsParsable(asset, amount, usdcAsset?.decimals);

		const signingProvider = createConfiguredSigningProvider(config, chain);
		const execution = await getExecutionPreview(config, chainConfig, signingProvider);
		const gasEstimate = await estimateTransferGasAndFees({
			chainConfig,
			asset,
			amount,
			toAddress,
			executionAddress: execution.executionAddress,
			erc20ContractAddress: usdcAsset?.address,
			erc20Decimals: usdcAsset?.decimals,
		});
		const warnings = [...execution.warnings, ...(gasEstimate.warning ? [gasEstimate.warning] : [])];

		if (cmdOpts.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					asset,
					amount,
					chain,
					chain_name: chainConfig.name,
					to_address: toAddress,
					execution_mode: execution.mode,
					execution_address: execution.executionAddress,
					funding_address: execution.fundingAddress,
					paymaster_provider: execution.paymasterProvider,
					estimated_gas_units:
						gasEstimate.gasUnits !== undefined ? gasEstimate.gasUnits.toString() : undefined,
					max_fee_per_gas_wei:
						gasEstimate.maxFeePerGasWei !== undefined
							? gasEstimate.maxFeePerGasWei.toString()
							: undefined,
					max_priority_fee_per_gas_wei:
						gasEstimate.maxPriorityFeePerGasWei !== undefined
							? gasEstimate.maxPriorityFeePerGasWei.toString()
							: undefined,
					gas_price_wei:
						gasEstimate.gasPriceWei !== undefined ? gasEstimate.gasPriceWei.toString() : undefined,
					warnings: warnings.length > 0 ? warnings : undefined,
				},
				opts,
				startTime,
			);
			return;
		}

		const approved = cmdOpts.yes
			? true
			: await promptYesNo(
					buildTransferConfirmationPrompt({
						asset,
						amount,
						toAddress,
						chain,
						chainName: chainConfig.name,
						execution,
						gasEstimate,
					}),
				);
		if (!approved) {
			success(
				{
					status: "cancelled",
					cancelled: true,
					asset,
					amount,
					chain,
					chain_name: chainConfig.name,
					to_address: toAddress,
				},
				opts,
				startTime,
			);
			return;
		}

		const transfer = await executeOnchainTransfer(config, signingProvider, {
			type: "transfer/request",
			actionId: `local-${randomUUID()}`,
			asset,
			amount,
			chain,
			toAddress,
		});
		const txUrl = chainConfig.blockExplorerUrl
			? `${chainConfig.blockExplorerUrl.replace(/\/$/, "")}/tx/${transfer.txHash}`
			: undefined;

		success(
			{
				status: "submitted",
				asset,
				amount,
				chain,
				chain_name: chainConfig.name,
				to_address: toAddress,
				tx_hash: transfer.txHash,
				tx_url: txUrl,
				execution_mode: execution.mode,
				execution_address: execution.executionAddress,
				funding_address: execution.fundingAddress,
				paymaster_provider: execution.paymasterProvider,
				estimated_gas_units:
					gasEstimate.gasUnits !== undefined ? gasEstimate.gasUnits.toString() : undefined,
				max_fee_per_gas_wei:
					gasEstimate.maxFeePerGasWei !== undefined
						? gasEstimate.maxFeePerGasWei.toString()
						: undefined,
				max_priority_fee_per_gas_wei:
					gasEstimate.maxPriorityFeePerGasWei !== undefined
						? gasEstimate.maxPriorityFeePerGasWei.toString()
						: undefined,
				gas_price_wei:
					gasEstimate.gasPriceWei !== undefined ? gasEstimate.gasPriceWei.toString() : undefined,
				warnings: warnings.length > 0 ? warnings : undefined,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

function normalizeRecipientAddress(toAddress: string): `0x${string}` {
	if (!isEthereumAddress(toAddress)) {
		throw new ValidationError(`Invalid recipient address: ${toAddress}`);
	}
	return getAddress(toAddress);
}

function normalizeAmount(amount: string): string {
	const trimmed = amount.trim();
	const numericAmount = Number(trimmed);
	if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
		throw new ValidationError(`Invalid amount: ${amount}. Amount must be a positive number.`);
	}
	return trimmed;
}

function assertAmountIsParsable(
	asset: "native" | "usdc",
	amount: string,
	erc20Decimals?: number,
): void {
	try {
		if (asset === "native") {
			parseEther(amount);
			return;
		}
		parseUnits(amount, erc20Decimals ?? 6);
	} catch {
		const label = asset === "native" ? "ETH" : "USDC";
		throw new ValidationError(`Invalid ${label} amount: ${amount}`);
	}
}

async function estimateTransferGasAndFees(input: {
	chainConfig: ChainConfig;
	asset: "native" | "usdc";
	amount: string;
	toAddress: `0x${string}`;
	executionAddress: `0x${string}`;
	erc20ContractAddress?: `0x${string}`;
	erc20Decimals?: number;
}): Promise<TransferGasEstimate> {
	try {
		const publicClient = buildPublicClient(input.chainConfig);
		const [fees, gasUnits] = await Promise.all([
			publicClient.estimateFeesPerGas(),
			input.asset === "native"
				? publicClient.estimateGas({
						account: input.executionAddress,
						to: input.toAddress,
						value: parseEther(input.amount),
						data: "0x",
					})
				: publicClient.estimateGas({
						account: input.executionAddress,
						to: input.erc20ContractAddress!,
						value: 0n,
						data: encodeFunctionData({
							abi: ERC20_TRANSFER_ABI,
							functionName: "transfer",
							args: [input.toAddress, parseUnits(input.amount, input.erc20Decimals ?? 6)],
						}),
					}),
		]);

		return {
			gasUnits,
			maxFeePerGasWei: fees.maxFeePerGas,
			maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas,
			gasPriceWei: fees.gasPrice,
		};
	} catch (error) {
		return {
			warning: `Gas estimate unavailable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function buildTransferConfirmationPrompt(input: {
	asset: "native" | "usdc";
	amount: string;
	toAddress: `0x${string}`;
	chain: string;
	chainName: string;
	execution: ExecutionPreview;
	gasEstimate: TransferGasEstimate;
}): string {
	const assetLabel = input.asset === "native" ? "ETH (native)" : "USDC";
	const feeQuote =
		input.gasEstimate.maxFeePerGasWei !== undefined
			? `maxFeePerGas=${input.gasEstimate.maxFeePerGasWei} wei${
					input.gasEstimate.maxPriorityFeePerGasWei !== undefined
						? `, maxPriorityFeePerGas=${input.gasEstimate.maxPriorityFeePerGasWei} wei`
						: ""
				}`
			: input.gasEstimate.gasPriceWei !== undefined
				? `gasPrice=${input.gasEstimate.gasPriceWei} wei`
				: "unavailable";
	const gasUnits =
		input.gasEstimate.gasUnits !== undefined
			? input.gasEstimate.gasUnits.toString()
			: "unavailable";

	return [
		"Transfer confirmation:",
		`- Asset: ${assetLabel}`,
		`- Amount: ${input.amount}`,
		`- Recipient: ${input.toAddress}`,
		`- Chain: ${input.chain} (${input.chainName})`,
		`- Execution mode: ${input.execution.mode}`,
		`- Paymaster: ${input.execution.paymasterProvider ?? "none"}`,
		`- Estimated gas units: ${gasUnits}`,
		`- Estimated fee quote: ${feeQuote}`,
		...(input.gasEstimate.warning ? [`- Gas estimation note: ${input.gasEstimate.warning}`] : []),
		...(input.execution.warnings.map((warning) => `- Execution note: ${warning}`) ?? []),
		"Proceed? [y/N] ",
	].join("\n");
}
