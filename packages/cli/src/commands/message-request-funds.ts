import { ValidationError, isEthereumAddress } from "trusted-agents-core";
import { normalizeAsset } from "../lib/assets.js";
import { resolveChainAlias } from "../lib/chains.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success, verbose } from "../lib/output.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

export interface RequestFundsOptions {
	asset: string;
	amount: string;
	chain?: string;
	to?: string;
	note?: string;
	dryRun?: boolean;
}

/**
 * `tap message request-funds` — ask a connected peer to transfer assets to a
 * specified address. After the Phase 3 refactor this command is a thin tapd
 * HTTP client; the daemon owns the action request flow.
 */
export async function messageRequestFundsCommand(
	peer: string,
	cmdOpts: RequestFundsOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const asset = normalizeAsset(cmdOpts.asset);
		const chain = resolveChainAlias(cmdOpts.chain ?? config.chain);
		const client = await TapdClient.forDataDir(config.dataDir);
		const toAddress = await resolveRecipientAddress(cmdOpts.to, client);

		if (cmdOpts.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					peer,
					asset,
					amount: cmdOpts.amount,
					chain,
					scope: "transfer/request",
					to_address: toAddress,
					...(cmdOpts.note ? { note: cmdOpts.note } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		verbose(`Requesting ${cmdOpts.amount} ${asset.toUpperCase()} from ${peer}...`, opts);

		const result = await client.requestFunds({
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
		handleCommandError(err, opts);
	}
}

async function resolveRecipientAddress(
	value: string | undefined,
	client: TapdClient,
): Promise<`0x${string}`> {
	if (value) {
		if (!isEthereumAddress(value)) {
			throw new ValidationError(`Invalid recipient address: ${value}`);
		}
		return value;
	}
	const identity = await client.getIdentity();
	if (!identity.address || !isEthereumAddress(identity.address)) {
		throw new ValidationError(
			"Could not resolve own address from tapd; pass --to <address> explicitly.",
		);
	}
	return identity.address as `0x${string}`;
}
