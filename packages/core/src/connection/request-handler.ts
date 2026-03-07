import { nowISO } from "../common/index.js";
import type { IAgentResolver } from "../identity/resolver.js";
import type { ResolvedAgent } from "../identity/types.js";
import { createEmptyPermissionState, createGrantSet } from "../permissions/types.js";
import type {
	AgentIdentifier,
	ConnectionPermissionIntent,
	ConnectionRequestParams,
	ConnectionResultParams,
	JsonRpcRequest,
} from "../protocol/types.js";
import type { ITrustStore } from "../trust/trust-store.js";
import type { Contact } from "../trust/types.js";

export interface ConnectionRequestContext {
	message: JsonRpcRequest;
	resolver: IAgentResolver;
	trustStore: ITrustStore;
	ownAgent: AgentIdentifier;
	approve: (
		peer: ResolvedAgent,
		permissionIntent: ConnectionPermissionIntent | undefined,
	) => Promise<boolean>;
}

export interface ConnectionRequestOutcome {
	peer: ResolvedAgent;
	result: ConnectionResultParams;
	contact: Contact | null;
}

export async function handleConnectionRequest(
	ctx: ConnectionRequestContext,
): Promise<ConnectionRequestOutcome> {
	const params = ctx.message.params as ConnectionRequestParams | undefined;
	if (
		typeof params?.from?.agentId !== "number" ||
		params.from.agentId < 0 ||
		typeof params.from.chain !== "string" ||
		params.from.chain.length === 0 ||
		typeof params.connectionId !== "string" ||
		params.connectionId.length === 0
	) {
		throw new Error("Invalid connection request parameters");
	}

	const resolved = await ctx.resolver.resolveWithCache(params.from.agentId, params.from.chain);
	const existing = await ctx.trustStore.findByAgentId(params.from.agentId, params.from.chain);
	if (existing && existing.status === "active") {
		return {
			peer: resolved,
			contact: existing,
			result: {
				requestId: String(ctx.message.id),
				requestNonce: params.nonce,
				from: ctx.ownAgent,
				to: params.from,
				status: "accepted",
				connectionId: existing.connectionId,
				timestamp: nowISO(),
			},
		};
	}

	const approved = await ctx.approve(resolved, params.permissionIntent);
	if (!approved) {
		return {
			peer: resolved,
			contact: null,
			result: {
				requestId: String(ctx.message.id),
				requestNonce: params.nonce,
				from: ctx.ownAgent,
				to: params.from,
				status: "rejected",
				reason: "Connection rejected by agent",
				timestamp: nowISO(),
			},
		};
	}

	const now = nowISO();
	const basePermissions = existing?.permissions ?? createEmptyPermissionState(now);
	const nextPermissions =
		params.permissionIntent?.offeredGrants && params.permissionIntent.offeredGrants.length > 0
			? {
					...basePermissions,
					grantedByPeer: createGrantSet(params.permissionIntent.offeredGrants, now),
				}
			: basePermissions;
	const nextContact: Contact = {
		connectionId: existing?.connectionId ?? params.connectionId,
		peerAgentId: resolved.agentId,
		peerChain: resolved.chain,
		peerOwnerAddress: resolved.ownerAddress,
		peerDisplayName: resolved.registrationFile.name,
		peerAgentAddress: resolved.agentAddress,
		permissions: nextPermissions,
		establishedAt: existing?.establishedAt ?? now,
		lastContactAt: now,
		status: "active",
	};

	if (existing) {
		await ctx.trustStore.updateContact(existing.connectionId, {
			...nextContact,
			pending: undefined,
		});
	} else {
		await ctx.trustStore.addContact(nextContact);
	}

	return {
		peer: resolved,
		contact: nextContact,
		result: {
			requestId: String(ctx.message.id),
			requestNonce: params.nonce,
			from: ctx.ownAgent,
			to: params.from,
			status: "accepted",
			connectionId: nextContact.connectionId,
			timestamp: now,
		},
	};
}
