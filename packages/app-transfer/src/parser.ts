import { extractMessageData, isEthereumAddress } from "trusted-agents-core";
import type { ProtocolMessage } from "trusted-agents-core";
import type { TransferActionRequest, TransferActionResponse } from "./types.js";

export function parseTransferActionRequest(message: ProtocolMessage): TransferActionRequest | null {
	if (message.method !== "action/request") {
		return null;
	}

	const data = extractMessageData(message);
	if (!data || data.type !== "transfer/request") {
		return null;
	}

	if (
		(data.asset !== "native" && data.asset !== "usdc") ||
		typeof data.actionId !== "string" ||
		data.actionId.length === 0 ||
		typeof data.amount !== "string" ||
		data.amount.length === 0 ||
		typeof data.chain !== "string" ||
		data.chain.length === 0 ||
		typeof data.toAddress !== "string" ||
		!isEthereumAddress(data.toAddress)
	) {
		return null;
	}

	return {
		type: "transfer/request",
		actionId: data.actionId,
		asset: data.asset,
		amount: data.amount,
		chain: data.chain,
		toAddress: data.toAddress,
		note: typeof data.note === "string" && data.note.length > 0 ? data.note : undefined,
	};
}

export function parseTransferActionResponse(
	message: ProtocolMessage,
): TransferActionResponse | null {
	if (message.method !== "action/result") {
		return null;
	}

	if (typeof message.params !== "object" || message.params === null) {
		return null;
	}

	const params = message.params as {
		requestId?: unknown;
		status?: unknown;
		message?: unknown;
	};
	if (
		typeof params.requestId !== "string" ||
		params.requestId.length === 0 ||
		(params.status !== "completed" && params.status !== "rejected" && params.status !== "failed")
	) {
		return null;
	}

	const data = extractMessageData({
		...message,
		params: { message: params.message },
	});
	if (!data || data.type !== "transfer/response") {
		return null;
	}

	if (
		(data.asset !== "native" && data.asset !== "usdc") ||
		typeof data.actionId !== "string" ||
		data.actionId.length === 0 ||
		typeof data.amount !== "string" ||
		data.amount.length === 0 ||
		typeof data.chain !== "string" ||
		data.chain.length === 0 ||
		typeof data.toAddress !== "string" ||
		!isEthereumAddress(data.toAddress)
	) {
		return null;
	}

	return {
		type: "transfer/response",
		requestId: params.requestId,
		actionId: data.actionId,
		asset: data.asset,
		amount: data.amount,
		chain: data.chain,
		toAddress: data.toAddress,
		status: params.status,
		txHash:
			typeof data.txHash === "string" && isEthereumAddressLikeHash(data.txHash)
				? data.txHash
				: undefined,
		error: typeof data.error === "string" && data.error.length > 0 ? data.error : undefined,
	};
}

export function buildTransferRequestText(request: TransferActionRequest): string {
	const assetLabel = request.asset === "native" ? "ETH" : "USDC";
	const note = request.note ? ` (${request.note})` : "";
	return `Requesting ${request.amount} ${assetLabel} on ${request.chain} to ${request.toAddress}${note}`;
}

export function buildTransferResponseText(response: TransferActionResponse): string {
	const assetLabel = response.asset === "native" ? "ETH" : "USDC";
	if (response.status === "completed") {
		return `Transferred ${response.amount} ${assetLabel} on ${response.chain} to ${response.toAddress}`;
	}
	if (response.status === "rejected") {
		return `Transfer request rejected for ${response.amount} ${assetLabel} on ${response.chain}`;
	}
	return `Transfer request failed for ${response.amount} ${assetLabel} on ${response.chain}: ${response.error ?? "unknown error"}`;
}

function isEthereumAddressLikeHash(value: string): value is `0x${string}` {
	return /^0x[0-9a-fA-F]{64}$/.test(value);
}
