import { createJsonRpcRequest } from "../protocol/index.js";
import { CONNECTION_ACCEPT, CONNECTION_REJECT, CONNECTION_REQUEST } from "../protocol/index.js";
import type {
	ConnectionAcceptParams,
	ConnectionRejectParams,
	ConnectionRequestParams,
	JsonRpcRequest,
} from "../protocol/index.js";

export function buildConnectionRequest(params: ConnectionRequestParams): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_REQUEST, params);
}

export function buildConnectionAccept(params: ConnectionAcceptParams): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_ACCEPT, params);
}

export function buildConnectionReject(params: ConnectionRejectParams): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_REJECT, params);
}
