import { createJsonRpcRequest } from "../protocol/index.js";
import {
	CONNECTION_ACCEPT,
	CONNECTION_REJECT,
	CONNECTION_REQUEST,
	CONNECTION_UPDATE_GRANTS,
} from "../protocol/index.js";
import type {
	ConnectionAcceptParams,
	ConnectionRejectParams,
	ConnectionRequestParams,
	ConnectionUpdateGrantsParams,
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

export function buildConnectionUpdateGrants(params: ConnectionUpdateGrantsParams): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_UPDATE_GRANTS, params);
}
