import {
	MESSAGE_ACTION_RESPONSE,
	PermissionError,
	ValidationError,
	generateNonce,
	isEthereumAddress,
} from "trusted-agents-core";
import type { JsonRpcResponse, ProtocolMessage } from "trusted-agents-core";
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

		let asyncResponse: TransferActionResponse | undefined;
		let resolveAsyncResponse: ((value: TransferActionResponse) => void) | null = null;
		const asyncResponsePromise = new Promise<TransferActionResponse>((resolve) => {
			resolveAsyncResponse = resolve;
		});

		ctx.transport.onMessage(async (from: number, message: ProtocolMessage) => {
			if (from !== contact.peerAgentId || message.method !== MESSAGE_ACTION_RESPONSE) {
				return {
					jsonrpc: "2.0" as const,
					id: message.id,
					error: { code: -32601, message: "Unexpected method for request-funds session" },
				};
			}

			const parsed = parseTransferActionResponse(message);
			if (!parsed || parsed.actionId !== requestPayload.actionId) {
				return {
					jsonrpc: "2.0" as const,
					id: message.id,
					error: { code: -32602, message: "Invalid transfer action response payload" },
				};
			}

			asyncResponse = parsed;
			resolveAsyncResponse?.(parsed);
			await appendConversationLog(ctx.conversationLogger, contact, message, "incoming");
			await ctx.trustStore.touchContact(contact.connectionId);
			await appendPermissionLedgerEntry(config.dataDir, {
				peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
				direction: "local",
				event: `transfer-${parsed.status}`,
				scope: "transfer/request",
				asset: parsed.asset,
				amount: parsed.amount,
				action_id: parsed.actionId,
				tx_hash: parsed.txHash,
				decision: parsed.status,
				rationale: parsed.error,
			});

			return {
				jsonrpc: "2.0" as const,
				id: message.id,
				result: { received: true, actionId: parsed.actionId },
			};
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
			const response = await ctx.transport.send(contact.peerAgentId, request, {
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

			if (response.error) {
				throw new PermissionError(response.error.message);
			}

			const result = (
				response as JsonRpcResponse & {
					result?: Record<string, unknown>;
				}
			).result;

			await waitForAsyncResponse(asyncResponsePromise, 5_000).catch(() => undefined);

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
					async_response_received: asyncResponse !== undefined,
					tx_hash:
						asyncResponse?.txHash ??
						(typeof result?.txHash === "string" ? result.txHash : undefined),
					status:
						asyncResponse?.status ??
						(typeof result?.status === "string" ? result.status : undefined),
					response: result,
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
