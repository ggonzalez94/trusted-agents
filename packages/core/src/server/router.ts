import {
	createJsonRpcError,
	createJsonRpcResponse,
	internalError,
	invalidRequest,
	methodNotFound,
	parseError,
} from "../protocol/index.js";
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "../protocol/types.js";
import type { MethodHandler, RequestContext } from "./types.js";

export function createRouter(handlers: Record<string, MethodHandler>) {
	return async (body: string, ctx: RequestContext): Promise<JsonRpcResponse> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return {
				jsonrpc: "2.0",
				id: "",
				error: parseError(),
			};
		}

		const request = parsed as Partial<JsonRpcRequest>;
		const requestId = normalizeJsonRpcId(request.id);

		if (
			!request ||
			typeof request !== "object" ||
			request.jsonrpc !== "2.0" ||
			typeof request.method !== "string" ||
			!isValidJsonRpcId(request.id)
		) {
			return {
				jsonrpc: "2.0",
				id: requestId,
				error: invalidRequest(),
			};
		}

		const handler = handlers[request.method];
		if (!handler) {
			return createJsonRpcError(request.id, methodNotFound());
		}

		try {
			const result = await handler(request.params, ctx);
			return createJsonRpcResponse(request.id, result);
		} catch {
			return createJsonRpcError(request.id, internalError());
		}
	};
}

function isValidJsonRpcId(id: unknown): id is JsonRpcId {
	return typeof id === "string" || typeof id === "number" || id === null;
}

function normalizeJsonRpcId(id: unknown): JsonRpcId {
	return isValidJsonRpcId(id) ? id : null;
}
