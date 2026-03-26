import { ValidationError, isEthereumAddress } from "trusted-agents-core";
import { normalizeAsset } from "../lib/assets.js";
import { resolveChainAlias } from "../lib/chains.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { findContactForPeer } from "../lib/message-conversations.js";
import { error, success, verbose } from "../lib/output.js";
import {
	isQueuedTapCommandPending,
	queuedTapCommandPendingFields,
	queuedTapCommandResultFields,
	runOrQueueTapCommand,
} from "../lib/queued-commands.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
import type { GlobalOptions } from "../types.js";

export interface RequestFundsOptions {
	asset: string;
	amount: string;
	chain?: string;
	to?: string;
	note?: string;
	dryRun?: boolean;
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
		const ownAddress = await ctx.signingProvider.getAddress();
		const toAddress = resolveRecipientAddress(cmdOpts.to, ownAddress);
		const contact = findContactForPeer(await ctx.trustStore.getContacts(), peer);
		if (!contact) {
			error("NOT_FOUND", `Peer not found in contacts: ${peer}`, opts);
			process.exitCode = 4;
			return;
		}

		if (cmdOpts.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					peer: contact.peerDisplayName,
					agent_id: contact.peerAgentId,
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

		const service = createCliTapMessagingService(ctx, opts, {
			ownerLabel: "tap:request-funds",
		});

		verbose(`Requesting ${cmdOpts.amount} ${asset.toUpperCase()} from ${peer}...`, opts);

		const requestInput = {
			peer,
			asset,
			amount: cmdOpts.amount,
			chain,
			toAddress,
			note: cmdOpts.note,
		};
		const outcome = await runOrQueueTapCommand(
			config.dataDir,
			{
				type: "request-funds",
				payload: {
					input: requestInput,
				},
			},
			async () => await service.requestFunds(requestInput),
			{
				requestedBy: "tap:request-funds",
			},
		);

		if (isQueuedTapCommandPending(outcome)) {
			success(
				{
					...queuedTapCommandPendingFields(outcome),
					peer,
					asset,
					amount: cmdOpts.amount,
					chain,
					scope: "transfer/request",
					to_address: toAddress,
				},
				opts,
				startTime,
			);
			return;
		}

		const result = outcome.result;

		success(
			{
				requested: true,
				...queuedTapCommandResultFields(outcome),
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
