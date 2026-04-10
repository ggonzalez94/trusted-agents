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

interface ConnectionRequestOutcome {
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

	// spec §5.2: every inbound valid connection/request converges the contact to "active".
	// The result is always "accepted" — there are no rejection paths for known peers.
	const result: ConnectionResultParams = {
		requestId: String(ctx.message.id),
		from: ctx.ownAgent,
		status: "accepted",
		timestamp: now,
	};

	// active: touch lastContactAt; no other changes needed.
	if (existing?.status === "active") {
		await ctx.trustStore.touchContact(existing.connectionId);
		return { peer: resolved, contact: existing, result };
	}

	// missing: create a fresh active contact with empty permissions.
	// connecting / idle / stale: upgrade to active, preserving permissions and establishedAt.
	// revoked: create a fresh active contact, overwriting the revoked record.
	//   Rationale: revokes are one-shot cleanup, not permanent blocks.
	//   A new valid signed invite counts as renewed consent with a clean slate.
	const isRevoked = existing?.status === "revoked";
	const freshSlate = !existing || isRevoked;

	const nextContact: Contact = {
		connectionId: existing?.connectionId ?? generateConnectionId(),
		peerAgentId: resolved.agentId,
		peerChain: resolved.chain,
		peerOwnerAddress: resolved.ownerAddress,
		peerDisplayName: resolved.registrationFile.name,
		peerAgentAddress: resolved.agentAddress,
		// Revoked and missing contacts get a clean permission slate; all others preserve.
		permissions: freshSlate ? createEmptyPermissionState(now) : existing.permissions,
		// Revoked and missing contacts get a fresh establishedAt; all others preserve.
		establishedAt: freshSlate ? now : existing.establishedAt,
		lastContactAt: now,
		status: "active",
		// expiresAt is explicitly cleared: once upgraded to active the invite expiry
		// hint (which only applies to connecting contacts) is no longer relevant.
		// Explicitly setting undefined ensures updateContact's spread does not carry
		// forward a prior expiresAt from a connecting contact.
		expiresAt: undefined,
	};

	if (existing) {
		await ctx.trustStore.updateContact(existing.connectionId, nextContact);
	} else {
		await ctx.trustStore.addContact(nextContact);
	}

	return { peer: resolved, contact: nextContact, result };
}
