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
