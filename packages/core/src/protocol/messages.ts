import { generateNonce } from "../common/index.js";
import type {
	JsonRpcErrorObject,
	JsonRpcRequest,
	JsonRpcResponse,
	Message,
	TrustedAgentMetadata,
} from "./types.js";

export function createJsonRpcRequest(
	method: string,
	params?: unknown,
	id?: string,
): JsonRpcRequest {
	return {
		jsonrpc: "2.0",
		method,
		id: id ?? generateNonce(),
		...(params !== undefined && { params }),
	};
}

export function createJsonRpcResponse(id: string, result: unknown): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		result,
	};
}

export function createJsonRpcError(id: string, error: JsonRpcErrorObject): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		error,
	};
}

export function createMessage(
	text: string,
	metadata?: { trustedAgent?: TrustedAgentMetadata },
): Message {
	return {
		messageId: generateNonce(),
		role: "user",
		parts: [{ kind: "text", text }],
		...(metadata !== undefined && { metadata }),
	};
}
