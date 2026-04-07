import { generateNonce } from "../common/index.js";
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
	if (typeof params !== "object" || params === null) {
		return null;
	}

	const payload = params as {
		message?: {
			metadata?: {
				trustedAgent?: {
					connectionId?: unknown;
				};
			};
		};
	};

	const connectionId = payload.message?.metadata?.trustedAgent?.connectionId;
	return typeof connectionId === "string" && connectionId.length > 0 ? connectionId : null;
}
