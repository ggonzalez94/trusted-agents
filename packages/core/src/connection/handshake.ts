import { createJsonRpcRequest } from "../protocol/index.js";
import { CONNECTION_REQUEST, CONNECTION_RESULT, PERMISSIONS_UPDATE } from "../protocol/index.js";
import type {
	ConnectionRequestParams,
	ConnectionResultParams,
	JsonRpcRequest,
	PermissionsUpdateParams,
} from "../protocol/index.js";

export function buildConnectionRequest(params: ConnectionRequestParams): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_REQUEST, params);
}

export function buildConnectionResult(params: ConnectionResultParams): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_RESULT, params);
}

export function buildPermissionsUpdate(params: PermissionsUpdateParams): JsonRpcRequest {
	return createJsonRpcRequest(PERMISSIONS_UPDATE, params);
}
