import {
	isEthereumAddress,
	isNonEmptyString,
	isObject,
	isRecord,
	readNonEmptyString,
} from "../common/index.js";
import type { PermissionGrant } from "../permissions/types.js";
import { ACTION_REQUEST, ACTION_RESULT } from "../protocol/methods.js";
import type { ProtocolMessage } from "../transport/interface.js";

export type TransferAsset = "native" | "usdc";

export interface TransferActionRequest extends Record<string, unknown> {
	type: "transfer/request";
	actionId: string;
	asset: TransferAsset;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
}

export interface TransferActionResponse extends Record<string, unknown> {
	type: "transfer/response";
	requestId?: string;
	actionId: string;
	asset: TransferAsset;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	status: "completed" | "rejected" | "failed";
	txHash?: `0x${string}`;
	error?: string;
}

export interface PermissionGrantRequestAction extends Record<string, unknown> {
	type: "permissions/request-grants";
	actionId: string;
	grants: PermissionGrant[];
	note?: string;
}

export function parseTransferActionRequest(message: ProtocolMessage): TransferActionRequest | null {
	const data = extractActionRequestData(message);
	return data ? parseTransferActionPayload(data) : null;
}

export function parseTransferActionPayload(
	data: Record<string, unknown>,
): TransferActionRequest | null {
	if (data.type !== "transfer/request") {
		return null;
	}

	if (!hasValidTransferFields(data)) {
		return null;
	}

	return {
		type: "transfer/request",
		actionId: data.actionId,
		asset: data.asset,
		amount: data.amount,
		chain: data.chain,
		toAddress: data.toAddress,
		note: readNonEmptyString(data.note),
	};
}

export function parseTransferActionResponse(
	message: ProtocolMessage,
): TransferActionResponse | null {
	const result = extractActionResultData(message);
	if (!result) return null;
	if (result.status !== "completed" && result.status !== "rejected" && result.status !== "failed") {
		return null;
	}

	const data = result.data;
	if (data.type !== "transfer/response") {
		return null;
	}

	if (!hasValidTransferFields(data)) {
		return null;
	}

	return {
		type: "transfer/response",
		requestId: result.requestId,
		actionId: data.actionId,
		asset: data.asset,
		amount: data.amount,
		chain: data.chain,
		toAddress: data.toAddress,
		status: result.status,
		txHash:
			typeof data.txHash === "string" && isEthereumAddressLikeHash(data.txHash)
				? data.txHash
				: undefined,
		error: readNonEmptyString(data.error),
	};
}

export function parsePermissionGrantRequest(
	message: ProtocolMessage,
): PermissionGrantRequestAction | null {
	const data = extractActionRequestData(message);
	if (!data || data.type !== "permissions/request-grants") {
		return null;
	}

	if (!isNonEmptyString(data.actionId) || !Array.isArray(data.grants)) {
		return null;
	}

	const grants: PermissionGrant[] = [];
	for (const input of data.grants) {
		if (!isObject(input)) {
			return null;
		}

		if (!isNonEmptyString(input.grantId) || !isNonEmptyString(input.scope)) {
			return null;
		}

		grants.push({
			grantId: input.grantId,
			scope: input.scope,
			...(isRecord(input.constraints) ? { constraints: input.constraints } : {}),
			status: input.status === "revoked" ? "revoked" : "active",
			updatedAt: isNonEmptyString(input.updatedAt) ? input.updatedAt : new Date().toISOString(),
		});
	}

	return {
		type: "permissions/request-grants",
		actionId: data.actionId,
		grants,
		note: readNonEmptyString(data.note),
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

export function buildPermissionGrantRequestText(request: PermissionGrantRequestAction): string {
	const summary = request.grants.map((grant) => grant.scope).join(", ");
	const note = request.note ? ` (${request.note})` : "";
	return `Requesting grant update for ${summary}${note}`;
}

export function extractMessageData(message: ProtocolMessage): Record<string, unknown> | null {
	if (!isObject(message.params)) {
		return null;
	}

	const container = message.params.message;
	if (!isObject(container)) {
		return null;
	}

	const parts = container.parts;
	if (!Array.isArray(parts)) {
		return null;
	}

	for (const part of parts) {
		if (isObject(part) && part.kind === "data" && isObject(part.data)) {
			return part.data;
		}
	}

	return null;
}

export function extractActionRequestData(message: ProtocolMessage): Record<string, unknown> | null {
	if (message.method !== ACTION_REQUEST) {
		return null;
	}

	return extractMessageData(message);
}

export function extractActionResultData(message: ProtocolMessage): {
	requestId: string;
	status: unknown;
	data: Record<string, unknown>;
} | null {
	if (message.method !== ACTION_RESULT) {
		return null;
	}

	if (!isObject(message.params)) {
		return null;
	}

	if (!isNonEmptyString(message.params.requestId)) {
		return null;
	}

	const data = extractMessageData({
		...message,
		params: { message: message.params.message },
	});
	if (!data) {
		return null;
	}

	return {
		requestId: message.params.requestId,
		status: message.params.status,
		data,
	};
}

function hasValidTransferFields(data: Record<string, unknown>): data is Record<string, unknown> & {
	asset: TransferAsset;
	actionId: string;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
} {
	return (
		(data.asset === "native" || data.asset === "usdc") &&
		isNonEmptyString(data.actionId) &&
		isNonEmptyString(data.amount) &&
		isNonEmptyString(data.chain) &&
		typeof data.toAddress === "string" &&
		isEthereumAddress(data.toAddress)
	);
}

function isEthereumAddressLikeHash(value: string): value is `0x${string}` {
	return /^0x[0-9a-fA-F]{64}$/.test(value);
}
