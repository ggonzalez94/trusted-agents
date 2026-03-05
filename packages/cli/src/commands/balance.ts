import { formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getUsdcAsset } from "../lib/assets.js";
import { resolveChainAlias } from "../lib/chains.js";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import { buildPublicClient } from "../lib/wallet.js";
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
		const chainConfig = config.chains[chain];
		if (!chainConfig) {
			error(
				"VALIDATION_ERROR",
				`Unknown chain: ${chainInput ?? chain}. Use a supported alias like base/base-sepolia or a CAIP-2 ID like eip155:8453.`,
				opts,
			);
			process.exitCode = 2;
			return;
		}

		const address = privateKeyToAccount(config.privateKey).address;
		const publicClient = buildPublicClient(chainConfig);
		const usdcAsset = getUsdcAsset(chain);

		const nativeBalancePromise = publicClient.getBalance({ address });
		const usdcBalancePromise = usdcAsset
			? (publicClient.readContract({
					address: usdcAsset.address,
					abi: ERC20_BALANCE_OF_ABI,
					functionName: "balanceOf",
					args: [address],
				}) as Promise<bigint>)
			: Promise.resolve<bigint | null>(null);

		const [nativeBalance, usdcBalance] = await Promise.all([
			nativeBalancePromise,
			usdcBalancePromise,
		]);

		success(
			{
				address,
				chain,
				chain_name: chainConfig.name,
				native_symbol: "ETH",
				native_balance: formatUnits(nativeBalance, 18),
				native_balance_wei: nativeBalance.toString(),
				usdc_supported: usdcAsset !== undefined,
				usdc_symbol: usdcAsset?.symbol,
				usdc_token_address: usdcAsset?.address,
				usdc_balance:
					usdcBalance !== null && usdcAsset
						? formatUnits(usdcBalance, usdcAsset.decimals)
						: undefined,
				usdc_balance_raw: usdcBalance !== null ? usdcBalance.toString() : undefined,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
