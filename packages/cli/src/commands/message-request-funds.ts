import { ValidationError, isEthereumAddress } from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import { resolveChainAlias } from "../lib/chains.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
import type { GlobalOptions } from "../types.js";

export interface RequestFundsOptions {
	asset: string;
	amount: string;
	chain?: string;
	to?: string;
	note?: string;
}

export async function messageRequestFundsCommand(
	peer: string,
	cmdOpts: RequestFundsOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);
		const asset = normalizeAsset(cmdOpts.asset);
		const chain = resolveChainAlias(cmdOpts.chain ?? config.chain);
		const ownAddress = privateKeyToAccount(config.privateKey).address;
		const toAddress = resolveRecipientAddress(cmdOpts.to, ownAddress);
		const service = createCliTapMessagingService(ctx, opts, {
			ownerLabel: "tap:request-funds",
		});

		verbose(`Requesting ${cmdOpts.amount} ${asset.toUpperCase()} from ${peer}...`, opts);

		const result = await service.requestFunds({
			peer,
			asset,
			amount: cmdOpts.amount,
			chain,
			toAddress,
			note: cmdOpts.note,
		});

		success(
			{
				requested: true,
				peer: result.peerName,
				agent_id: result.peerAgentId,
				asset: result.asset,
				amount: result.amount,
				chain: result.chain,
				scope: "transfer/request",
				to_address: result.toAddress,
				action_id: result.actionId,
				receipt: result.receipt,
				async_response_received: result.asyncResult !== undefined,
				tx_hash: result.asyncResult?.txHash,
				status: result.asyncResult?.status,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

function normalizeAsset(asset: string): "native" | "usdc" {
	const normalized = asset.trim().toLowerCase();
	if (normalized === "native" || normalized === "usdc") {
		return normalized;
	}
	throw new ValidationError(`Unsupported asset: ${asset}. Use "native" or "usdc".`);
}

function resolveRecipientAddress(
	value: string | undefined,
	fallback: `0x${string}`,
): `0x${string}` {
	if (!value) {
		return fallback;
	}
	if (!isEthereumAddress(value)) {
		throw new ValidationError(`Invalid recipient address: ${value}`);
	}
	return value;
}
