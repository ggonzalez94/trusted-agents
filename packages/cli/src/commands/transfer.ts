import { ValidationError, isEthereumAddress } from "trusted-agents-core";
import { getAddress, parseEther, parseUnits } from "viem";
import { normalizeAsset } from "../lib/assets.js";
import { requireChainConfig, resolveChainAlias } from "../lib/chains.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import { promptYesNo } from "../lib/prompt.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

interface TransferCommandOptions {
	to: string;
	asset: string;
	amount: string;
	chain?: string;
	dryRun?: boolean;
	yes?: boolean;
}

/**
 * `tap transfer` — execute an on-chain transfer through tapd's owned signing
 * provider. After the Phase 3 refactor the CLI is a thin client: validate
 * inputs, prompt for confirmation, post to `/api/transfers`, format the
 * response. The daemon owns the OWS wallet.
 */
export async function transferCommand(
	cmdOpts: TransferCommandOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const chain = resolveChainAlias(cmdOpts.chain ?? config.chain);
		const chainConfig = requireChainConfig(config, chain, cmdOpts.chain);

		const asset = normalizeAsset(cmdOpts.asset);
		const toAddress = normalizeRecipientAddress(cmdOpts.to);
		const amount = normalizeAmount(cmdOpts.amount);
		assertAmountIsParsable(asset, amount);

		const base = { asset, amount, chain, chain_name: chainConfig.name, to_address: toAddress };

		if (cmdOpts.dryRun) {
			success(
				{ status: "preview", dry_run: true, scope: "transfer/execute", ...base },
				opts,
				startTime,
			);
			return;
		}

		const approved = cmdOpts.yes
			? true
			: await promptYesNo(
					[
						"Transfer confirmation:",
						`- Asset: ${asset === "native" ? "ETH (native)" : "USDC"}`,
						`- Amount: ${amount}`,
						`- Recipient: ${toAddress}`,
						`- Chain: ${chain} (${chainConfig.name})`,
						"Proceed? [y/N] ",
					].join("\n"),
				);

		if (!approved) {
			success({ status: "cancelled", cancelled: true, ...base }, opts, startTime);
			return;
		}

		const client = await TapdClient.forDataDir(config.dataDir);
		const result = await client.transfer({
			asset,
			amount,
			chain,
			toAddress,
		});

		const txUrl = chainConfig.blockExplorerUrl
			? `${chainConfig.blockExplorerUrl.replace(/\/$/, "")}/tx/${result.txHash}`
			: undefined;

		success(
			{ status: "submitted", ...base, tx_hash: result.txHash, tx_url: txUrl },
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
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

function assertAmountIsParsable(asset: "native" | "usdc", amount: string): void {
	try {
		if (asset === "native") {
			parseEther(amount);
			return;
		}
		parseUnits(amount, 6);
	} catch {
		const label = asset === "native" ? "ETH" : "USDC";
		throw new ValidationError(`Invalid ${label} amount: ${amount}`);
	}
}
