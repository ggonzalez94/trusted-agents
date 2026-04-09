import { createJsonRpcRequest } from "../protocol/index.js";
import { CONNECTION_REQUEST, CONNECTION_RESULT, PERMISSIONS_UPDATE } from "../protocol/index.js";
import type {
	ConnectionRequestParams,
	ConnectionResultParams,
	JsonRpcId,
	JsonRpcRequest,
	PermissionsUpdateParams,
} from "../protocol/index.js";

export function buildConnectionRequest(params: ConnectionRequestParams): JsonRpcRequest {
	return createJsonRpcRequest(CONNECTION_REQUEST, params);
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
