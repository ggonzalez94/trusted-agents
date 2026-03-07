import {
	ACTION_RESULT,
	PermissionError,
	ValidationError,
	generateNonce,
	isEthereumAddress,
} from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import type { TransferActionResponse } from "../lib/actions.js";
import { buildTransferRequestText, parseTransferActionResponse } from "../lib/actions.js";
import { resolveChainAlias } from "../lib/chains.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import {
	appendConversationLog,
	buildOutgoingActionRequest,
	findContactForPeer,
} from "../lib/message-conversations.js";
import { createMessageRuntime } from "../lib/message-runtime.js";
import { error, success, verbose } from "../lib/output.js";
import { appendPermissionLedgerEntry } from "../lib/permission-ledger.js";
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
		const contacts = await ctx.trustStore.getContacts();
		const contact = findContactForPeer(contacts, peer);
		if (!contact) {
			error("NOT_FOUND", `Peer not found in contacts: ${peer}`, opts);
			process.exitCode = 1;
			return;
		}

		const asset = normalizeAsset(cmdOpts.asset);
		const chain = resolveChainAlias(cmdOpts.chain ?? config.chain);
		const ownAddress = privateKeyToAccount(config.privateKey).address;
		const toAddress = resolveRecipientAddress(cmdOpts.to, ownAddress);
		const requestPayload = {
			type: "transfer/request" as const,
			actionId: generateNonce(),
			asset,
			amount: cmdOpts.amount,
			chain,
			toAddress,
			note: cmdOpts.note,
		};
		const request = buildOutgoingActionRequest(
			contact,
			buildTransferRequestText(requestPayload),
			requestPayload,
			"transfer/request",
		);
		const requestId = String(request.id);

		let asyncResponse: TransferActionResponse | undefined;
		let resolveAsyncResponse: ((value: TransferActionResponse) => void) | undefined;
		const asyncResponsePromise = new Promise<TransferActionResponse>((resolve) => {
			resolveAsyncResponse = resolve;
		});

		const runtime = createMessageRuntime(config, ctx, opts, {
			autoApproveConnections: false,
			autoApproveActions: false,
			emitEvents: false,
		});
		ctx.transport.setHandlers({
			onRequest: runtime.handlers.onRequest,
			onResult: async (envelope) => {
				const ack = (await runtime.handlers.onResult?.(envelope)) ?? {
					status: "received" as const,
				};
				if (envelope.from === contact.peerAgentId && envelope.message.method === ACTION_RESULT) {
					const parsed = parseTransferActionResponse(envelope.message);
					if (parsed?.requestId === requestId && parsed.actionId === requestPayload.actionId) {
						asyncResponse = parsed;
						resolveAsyncResponse?.(parsed);
					}
				}
				return ack;
			},
		});

		await ctx.transport.start?.();
		try {
			verbose(
				`Requesting ${cmdOpts.amount} ${asset.toUpperCase()} from ${contact.peerDisplayName}...`,
				opts,
			);

			const requestTimestamp = new Date().toISOString();
			await appendPermissionLedgerEntry(config.dataDir, {
				timestamp: requestTimestamp,
				peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
				direction: "local",
				event: "transfer-request-sent",
				scope: "transfer/request",
				asset,
				amount: cmdOpts.amount,
				action_id: requestPayload.actionId,
				note: cmdOpts.note,
			});

			const receipt = await ctx.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
			});
			await appendConversationLog(
				ctx.conversationLogger,
				contact,
				request,
				"outgoing",
				requestTimestamp,
			);
			await ctx.trustStore.touchContact(contact.connectionId);
			await ctx.requestJournal.putOutbound({
				requestId,
				requestKey: `outbound:${request.method}:${requestId}`,
				direction: "outbound",
				kind: "request",
				method: request.method,
				peerAgentId: contact.peerAgentId,
				status: "acked",
			});

			await waitForAsyncResponse(asyncResponsePromise, 5_000).catch(() => undefined);
			if (asyncResponse === undefined) {
				await ctx.transport.reconcile?.();
			}
			await runtime.drain();
			if (asyncResponse?.status === "rejected") {
				throw new PermissionError(asyncResponse.error ?? "Action rejected by agent");
			}
			if (asyncResponse?.status === "failed") {
				throw new Error(asyncResponse.error ?? "Transfer request failed");
			}

			success(
				{
					requested: true,
					peer: contact.peerDisplayName,
					agent_id: contact.peerAgentId,
					asset,
					amount: cmdOpts.amount,
					chain,
					scope: "transfer/request",
					to_address: toAddress,
					action_id: requestPayload.actionId,
					receipt,
					async_response_received: asyncResponse !== undefined,
					tx_hash: asyncResponse?.txHash,
					status: asyncResponse?.status,
				},
				opts,
				startTime,
			);
		} finally {
			await ctx.transport.stop?.();
		}
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

async function waitForAsyncResponse(
	promise: Promise<TransferActionResponse>,
	timeoutMs: number,
): Promise<TransferActionResponse> {
	return await Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Timed out waiting for action response")), timeoutMs),
		),
	]);
}
