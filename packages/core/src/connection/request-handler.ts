import { generateConnectionId, nowISO } from "../common/index.js";
import type { IAgentResolver } from "../identity/resolver.js";
import type { ResolvedAgent } from "../identity/types.js";
import { createEmptyPermissionState } from "../permissions/types.js";
import type {
	AgentIdentifier,
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
		params.from.chain.length === 0
	) {
		throw new Error("Invalid connection request parameters");
	}

	const resolved = await ctx.resolver.resolveWithCache(params.from.agentId, params.from.chain);
	const existing = await ctx.trustStore.findByAgentId(params.from.agentId, params.from.chain);
	const now = nowISO();
	if (existing && existing.status === "active") {
		await ctx.trustStore.touchContact(existing.connectionId);
		return {
			peer: resolved,
			contact: existing,
			result: {
				requestId: String(ctx.message.id),
				from: ctx.ownAgent,
				status: "accepted",
				timestamp: now,
			},
		};
	}

	const nextContact: Contact = {
		connectionId: existing?.connectionId ?? generateConnectionId(),
		peerAgentId: resolved.agentId,
		peerChain: resolved.chain,
		peerOwnerAddress: resolved.ownerAddress,
		peerDisplayName: resolved.registrationFile.name,
		peerAgentAddress: resolved.agentAddress,
		permissions: existing?.permissions ?? createEmptyPermissionState(now),
		establishedAt: existing?.establishedAt ?? now,
		lastContactAt: now,
		status: "active",
	};

	if (existing) {
		await ctx.trustStore.updateContact(existing.connectionId, nextContact);
	} else {
		await ctx.trustStore.addContact(nextContact);
	}

	return {
		peer: resolved,
		contact: nextContact,
		result: {
			requestId: String(ctx.message.id),
			from: ctx.ownAgent,
			status: "accepted",
			timestamp: now,
		},
	};
}
