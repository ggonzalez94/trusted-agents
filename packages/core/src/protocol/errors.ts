import type { JsonRpcErrorObject } from "./types.js";

export function parseError(data?: unknown): JsonRpcErrorObject {
	return { code: -32700, message: "Parse error", ...(data !== undefined && { data }) };
}

export function invalidRequest(data?: unknown): JsonRpcErrorObject {
	return { code: -32600, message: "Invalid Request", ...(data !== undefined && { data }) };
}

export function methodNotFound(data?: unknown): JsonRpcErrorObject {
	return { code: -32601, message: "Method not found", ...(data !== undefined && { data }) };
}

export function invalidParams(data?: unknown): JsonRpcErrorObject {
	return { code: -32602, message: "Invalid params", ...(data !== undefined && { data }) };
}

export function internalError(data?: unknown): JsonRpcErrorObject {
	return { code: -32603, message: "Internal error", ...(data !== undefined && { data }) };
}

export function forbidden(): JsonRpcErrorObject {
	return { code: 403, message: "Forbidden" };
}

export function unauthorized(): JsonRpcErrorObject {
	return { code: 401, message: "Unauthorized" };
}
