import { generateNonce, isObject } from "../common/index.js";
import type { JsonRpcId, JsonRpcRequest } from "./types.js";

export function createJsonRpcRequest(
	method: string,
	params?: unknown,
	id?: JsonRpcId,
): JsonRpcRequest {
	return {
		jsonrpc: "2.0",
		method,
		id: id ?? generateNonce(),
		...(params !== undefined && { params }),
	};
}

export function extractConnectionIdFromParams(params: unknown): string | null {
	if (!isObject(params)) {
		return null;
	}

	const message = isObject(params.message) ? params.message : undefined;
	const metadata = message && isObject(message.metadata) ? message.metadata : undefined;
	const trustedAgent =
		metadata && isObject(metadata.trustedAgent) ? metadata.trustedAgent : undefined;
	const connectionId = trustedAgent?.connectionId;
	return typeof connectionId === "string" && connectionId.length > 0 ? connectionId : null;
}
