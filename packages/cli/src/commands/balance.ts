import { buildChainPublicClient, getExecutionPreview, getUsdcAsset } from "trusted-agents-core";
import { formatUnits } from "viem";
import { requireChainConfig, resolveChainAlias } from "../lib/chains.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import { createConfiguredSigningProvider } from "../lib/wallet-config.js";
import type { GlobalOptions } from "../types.js";

const ERC20_BALANCE_OF_ABI = [
	{
		type: "function",
		name: "balanceOf",
		stateMutability: "view",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "balance", type: "uint256" }],
	},
] as const;

export async function balanceCommand(opts: GlobalOptions, chainInput?: string): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const chain = chainInput ? resolveChainAlias(chainInput) : config.chain;
		const chainConfig = requireChainConfig(config, chain, chainInput);

		const signingProvider = createConfiguredSigningProvider(config);
		const messagingAddress = await signingProvider.getAddress();
		const execution = await getExecutionPreview(config, chainConfig, signingProvider);
		const executionAddress = execution.executionAddress;
		const publicClient = buildChainPublicClient(chainConfig);
		const usdcAsset = getUsdcAsset(chain);

		const messagingNativeBalancePromise = publicClient.getBalance({ address: messagingAddress });
		const executionNativeBalancePromise =
			executionAddress.toLowerCase() === messagingAddress.toLowerCase()
				? messagingNativeBalancePromise
				: publicClient.getBalance({ address: executionAddress });
		const messagingUsdcBalancePromise = usdcAsset
			? (publicClient.readContract({
					address: usdcAsset.address,
					abi: ERC20_BALANCE_OF_ABI,
					functionName: "balanceOf",
					args: [messagingAddress],
				}) as Promise<bigint>)
			: Promise.resolve<bigint | null>(null);
		const executionUsdcBalancePromise =
			usdcAsset && executionAddress.toLowerCase() !== messagingAddress.toLowerCase()
				? (publicClient.readContract({
						address: usdcAsset.address,
						abi: ERC20_BALANCE_OF_ABI,
						functionName: "balanceOf",
						args: [executionAddress],
					}) as Promise<bigint>)
				: messagingUsdcBalancePromise;

		const [
			messagingNativeBalance,
			executionNativeBalance,
			messagingUsdcBalance,
			executionUsdcBalance,
		] = await Promise.all([
			messagingNativeBalancePromise,
			executionNativeBalancePromise,
			messagingUsdcBalancePromise,
			executionUsdcBalancePromise,
		]);

		success(
			{
				address: messagingAddress,
				messaging_address: messagingAddress,
				execution_address: executionAddress,
				funding_address: execution.fundingAddress,
				execution_mode: execution.mode,
				paymaster_provider: execution.paymasterProvider,
				chain,
				chain_name: chainConfig.name,
				native_symbol: "ETH",
				messaging_native_balance: formatUnits(messagingNativeBalance, 18),
				messaging_native_balance_wei: messagingNativeBalance.toString(),
				execution_native_balance: formatUnits(executionNativeBalance, 18),
				execution_native_balance_wei: executionNativeBalance.toString(),
				usdc_supported: usdcAsset !== undefined,
				usdc_symbol: usdcAsset?.symbol,
				usdc_token_address: usdcAsset?.address,
				messaging_usdc_balance:
					messagingUsdcBalance !== null && usdcAsset
						? formatUnits(messagingUsdcBalance, usdcAsset.decimals)
						: undefined,
				messaging_usdc_balance_raw:
					messagingUsdcBalance !== null ? messagingUsdcBalance.toString() : undefined,
				execution_usdc_balance:
					executionUsdcBalance !== null && usdcAsset
						? formatUnits(executionUsdcBalance, usdcAsset.decimals)
						: undefined,
				execution_usdc_balance_raw:
					executionUsdcBalance !== null ? executionUsdcBalance.toString() : undefined,
				warnings: execution.warnings.length ? execution.warnings : undefined,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
