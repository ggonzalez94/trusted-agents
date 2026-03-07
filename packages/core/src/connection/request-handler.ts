import { generateConnectionId, nowISO } from "../common/index.js";
import type { IAgentResolver } from "../identity/resolver.js";
import type { ResolvedAgent } from "../identity/types.js";
import { createEmptyPermissionState } from "../permissions/types.js";
import { createJsonRpcError, createJsonRpcResponse } from "../protocol/messages.js";
import type {
	AgentIdentifier,
	ConnectionPermissionIntent,
	ConnectionRequestParams,
} from "../protocol/types.js";
import type { ProtocolMessage, ProtocolResponse } from "../transport/interface.js";
import type { ITrustStore } from "../trust/trust-store.js";
import type { Contact } from "../trust/types.js";

export interface ConnectionRequestContext {
	/** The incoming connection/request message (already verified by transport). */
	message: ProtocolMessage;
	/** Resolver to look up the requester's on-chain identity. */
	resolver: IAgentResolver;
	/** Trust store to persist the new contact. */
	trustStore: ITrustStore;
	/** This agent's identity. */
	ownAgent: AgentIdentifier;
	/**
	 * Approval callback — receives the resolved peer identity, returns true to
	 * accept or false to reject. This is where CLI prompts or SDK delegates.
	 */
	approve: (
		peer: ResolvedAgent,
		permissionIntent: ConnectionPermissionIntent | undefined,
	) => Promise<boolean>;
}

export async function handleConnectionRequest(
	ctx: ConnectionRequestContext,
): Promise<ProtocolResponse> {
	const params = ctx.message.params as ConnectionRequestParams | undefined;
	if (!params?.from?.agentId || !params.from.chain) {
		return createJsonRpcError(ctx.message.id, {
			code: -32602,
			message: "Invalid connection request parameters",
		});
	}

	// Resolve requester's on-chain identity (cache-first — transport already resolved recently)
	let resolved: ResolvedAgent;
	try {
		resolved = await ctx.resolver.resolveWithCache(params.from.agentId, params.from.chain);
	} catch {
		return createJsonRpcError(ctx.message.id, {
			code: -32001,
			message: "Failed to resolve requester identity",
		});
	}

	// Check if already a contact (idempotency)
	const existing = await ctx.trustStore.findByAgentId(params.from.agentId, params.from.chain);
	if (existing && existing.status === "active") {
		return createJsonRpcResponse(ctx.message.id, {
			accepted: true,
			connectionId: existing.connectionId,
			from: ctx.ownAgent,
			to: params.from,
			requestNonce: params.nonce,
			timestamp: nowISO(),
		});
	}

	// Ask for approval
	const approved = await ctx.approve(resolved, params.permissionIntent);
	if (!approved) {
		return createJsonRpcResponse(ctx.message.id, {
			accepted: false,
			from: ctx.ownAgent,
			to: params.from,
			reason: "Connection rejected by agent",
			nonce: params.nonce,
			timestamp: nowISO(),
		});
	}

	// Store contact
	const connectionId = generateConnectionId();
	const now = nowISO();
	const contact: Contact = {
		connectionId,
		peerAgentId: resolved.agentId,
		peerChain: resolved.chain,
		peerOwnerAddress: resolved.ownerAddress,
		peerDisplayName: resolved.registrationFile.name,
		peerAgentAddress: resolved.agentAddress,
		permissions: createEmptyPermissionState(now),
		establishedAt: now,
		lastContactAt: now,
		status: "active",
	};
	await ctx.trustStore.addContact(contact);

	return createJsonRpcResponse(ctx.message.id, {
		accepted: true,
		connectionId,
		from: ctx.ownAgent,
		to: params.from,
		requestNonce: params.nonce,
		timestamp: now,
	});
}
