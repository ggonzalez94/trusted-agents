import {
	createJsonRpcError,
	createJsonRpcResponse,
	internalError,
	invalidRequest,
	methodNotFound,
	parseError,
} from "../protocol/index.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../protocol/types.js";
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

		const request = parsed as JsonRpcRequest;

		if (
			!request ||
			typeof request !== "object" ||
			request.jsonrpc !== "2.0" ||
			!request.method ||
			!request.id
		) {
			return {
				jsonrpc: "2.0",
				id:
					request && typeof request === "object" && typeof request.id === "string"
						? request.id
						: "",
				error: invalidRequest(),
			};
		}

		const handler = handlers[request.method];
		if (!handler) {
			return createJsonRpcError(request.id, methodNotFound(request.method));
		}

		try {
			const result = await handler(request.params, ctx);
			return createJsonRpcResponse(request.id, result);
		} catch (err) {
			return createJsonRpcError(
				request.id,
				internalError(err instanceof Error ? err.message : undefined),
			);
		}
	};
}
