import { ValidationError } from "../common/index.js";
import { createJsonRpcRequest } from "../protocol/index.js";
import {
	CONNECTION_REQUEST,
	CONNECTION_RESULT,
	CONNECTION_REVOKE,
	PERMISSIONS_UPDATE,
} from "../protocol/index.js";
import type {
	ConnectionRequestParams,
	ConnectionResultParams,
	ConnectionRevokeParams,
	JsonRpcId,
	JsonRpcRequest,
	PermissionsUpdateParams,
} from "../protocol/index.js";
import type { ProtocolMessage } from "../transport/interface.js";

export function buildConnectionRequest(
	params: ConnectionRequestParams,
	id?: JsonRpcId,
): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_REQUEST, params, id);
}

export function buildConnectionResult(
	params: ConnectionResultParams,
	id?: JsonRpcId,
): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_RESULT, params, id);
}

/**
 * Deterministic JSON-RPC id for an outbound connection/result tied to a given
 * inbound connection/request. Used so that repeated `sendConnectionResult`
 * calls for the same correlation upsert a single journal entry instead of
 * accumulating one entry per retry.
 *
 * The id MUST include peer identity (chain + agentId) because JSON-RPC request
 * ids are only unique within a single client's own request space — two
 * different peers can happily both use id "1" for their connection/request,
 * and without peer scoping their derived connection-result ids would collide
 * and overwrite each other's pending journal entry.
 */
export function deriveConnectionResultId(params: {
	chain: string;
	peerAgentId: number;
	correlationId: string;
}): string {
	return `connection-result:${params.chain}:${params.peerAgentId}:${params.correlationId}`;
}

export function buildPermissionsUpdate(params: PermissionsUpdateParams): JsonRpcRequest {
	return createJsonRpcRequest(PERMISSIONS_UPDATE, params);
}

export function buildConnectionRevoke(params: ConnectionRevokeParams): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_REVOKE, params);
}

export function parseConnectionRevoke(message: ProtocolMessage): ConnectionRevokeParams {
	const params = message.params as ConnectionRevokeParams | undefined;
	if (
		typeof params?.from?.agentId !== "number" ||
		params.from.agentId < 0 ||
		typeof params.from.chain !== "string" ||
		params.from.chain.length === 0 ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid connection/revoke parameters");
	}
	return params;
}
