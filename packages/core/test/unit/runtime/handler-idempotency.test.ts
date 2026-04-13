/**
 * Table-driven idempotency tests for handleConnectionRequest.
 * Covers every row of spec §5.2 from the connection-flow-simplification design doc.
 *
 * handleConnectionRequest is now pure — it performs no trust store writes.
 * These tests assert on the returned plannedContact / existingContact values
 * (option b per the task spec). Trust store integration is verified at the
 * service layer (service.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { handleConnectionRequest } from "../../../src/connection/request-handler.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { createGrantSet } from "../../../src/permissions/types.js";
import type { ITrustStore } from "../../../src/trust/trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import { ALICE } from "../../fixtures/test-keys.js";

// ──────────────────────────────────────────────────────────────
// Shared fixtures
// ──────────────────────────────────────────────────────────────

/** Alice is the peer sending the connection/request. */
const PEER_AGENT_ID = 10;
const PEER_CHAIN = "eip155:8453";

/** Bob is the local agent receiving the request. */
const OWN_AGENT = { agentId: 20, chain: "eip155:8453" };

const ALICE_RESOLVED: ResolvedAgent = {
	agentId: PEER_AGENT_ID,
	chain: PEER_CHAIN,
	ownerAddress: ALICE.address,
	agentAddress: ALICE.address,
	capabilities: ["chat"],
	registrationFile: {
		type: "eip-8004-registration-v1",
		name: "Alice",
		description: "Test agent",
		services: [{ name: "xmtp", endpoint: ALICE.address }],
		trustedAgentProtocol: {
			version: "1.0",
			agentAddress: ALICE.address,
			capabilities: ["chat"],
		},
	},
	resolvedAt: "2025-01-01T00:00:00.000Z",
};

/** Permissions representing a prior connection — non-empty grants so we can tell if they were preserved or reset. */
const PRIOR_PERMISSIONS = {
	grantedByMe: createGrantSet(
		[{ grantId: "grant-1", scope: "transfer" }],
		"2025-01-01T00:00:00.000Z",
	),
	grantedByPeer: createGrantSet(
		[{ grantId: "grant-2", scope: "transfer" }],
		"2025-01-01T00:00:00.000Z",
	),
};
const PRIOR_ESTABLISHED_AT = "2025-01-01T00:00:00.000Z";

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function makeMockResolver(): IAgentResolver {
	return {
		resolve: async () => ALICE_RESOLVED,
		resolveWithCache: async () => ALICE_RESOLVED,
	};
}

function makeMockTrustStore(existing: Contact | null = null): ITrustStore {
	return {
		getContacts: vi.fn<ITrustStore["getContacts"]>().mockResolvedValue(existing ? [existing] : []),
		getContact: vi.fn<ITrustStore["getContact"]>().mockResolvedValue(null),
		findByAgentAddress: vi.fn<ITrustStore["findByAgentAddress"]>().mockResolvedValue(null),
		findByAgentId: vi.fn<ITrustStore["findByAgentId"]>().mockResolvedValue(existing),
		addContact: vi.fn<ITrustStore["addContact"]>().mockResolvedValue(undefined),
		updateContact: vi.fn<ITrustStore["updateContact"]>().mockResolvedValue(undefined),
		removeContact: vi.fn<ITrustStore["removeContact"]>().mockResolvedValue(undefined),
		touchContact: vi.fn<ITrustStore["touchContact"]>().mockResolvedValue(undefined),
	};
}

function makeContact(status: Contact["status"], extra: Partial<Contact> = {}): Contact {
	return {
		connectionId: "existing-conn-001",
		peerAgentId: PEER_AGENT_ID,
		peerChain: PEER_CHAIN,
		peerOwnerAddress: ALICE.address,
		peerDisplayName: "Alice",
		peerAgentAddress: ALICE.address,
		permissions: PRIOR_PERMISSIONS,
		establishedAt: PRIOR_ESTABLISHED_AT,
		lastContactAt: PRIOR_ESTABLISHED_AT,
		status,
		...extra,
	};
}

function makeRequest() {
	return {
		jsonrpc: "2.0" as const,
		id: "req-1",
		method: "connection/request",
		params: {
			from: { agentId: PEER_AGENT_ID, chain: PEER_CHAIN },
			invite: {
				agentId: OWN_AGENT.agentId,
				chain: OWN_AGENT.chain,
				expires: 1_893_456_000,
				signature: `0x${"1".repeat(130)}` as `0x${string}`,
			},
			timestamp: "2025-01-01T00:00:00.000Z",
		},
	};
}

/** Checks that the given ContactPermissionState looks like createEmptyPermissionState output. */
function isEmptyPermissions(permissions: Contact["permissions"]): boolean {
	return (
		permissions.grantedByMe.grants.length === 0 && permissions.grantedByPeer.grants.length === 0
	);
}

// ──────────────────────────────────────────────────────────────
// §5.2 idempotency table — asserts on PLANNING LOGIC only.
// The handler is pure; these tests verify the returned
// plannedContact and existingContact fields without touching
// the trust store. Service-layer integration is in service.test.ts.
// ──────────────────────────────────────────────────────────────

describe("handleConnectionRequest — §5.2 idempotency table", () => {
	// ── missing ────────────────────────────────────────────────
	it("missing → plans a fresh active contact with empty permissions", async () => {
		const trustStore = makeMockTrustStore(null);

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore,
			ownAgent: OWN_AGENT,
		});

		// result is accepted
		expect(outcome.result.status).toBe("accepted");

		// no prior contact
		expect(outcome.existingContact).toBeNull();

		// planned contact is fresh active with empty permissions
		expect(outcome.plannedContact.status).toBe("active");
		expect(isEmptyPermissions(outcome.plannedContact.permissions)).toBe(true);
		// connectionId is a fresh UUID
		expect(outcome.plannedContact.connectionId).toBeDefined();
		expect(outcome.plannedContact.connectionId).not.toBe("existing-conn-001");

		// pure — no trust store writes
		expect(trustStore.addContact).not.toHaveBeenCalled();
		expect(trustStore.updateContact).not.toHaveBeenCalled();
		expect(trustStore.touchContact).not.toHaveBeenCalled();
	});

	// ── connecting ─────────────────────────────────────────────
	it("connecting → plans upgrade to active, preserving permissions and establishedAt", async () => {
		const existing = makeContact("connecting", { expiresAt: "2099-01-01T00:00:00.000Z" });
		const trustStore = makeMockTrustStore(existing);

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");
		expect(outcome.existingContact?.connectionId).toBe("existing-conn-001");
		expect(outcome.existingContact?.status).toBe("connecting");

		// planned contact is active
		expect(outcome.plannedContact.status).toBe("active");

		// permissions preserved (connecting is not a fresh slate)
		expect(outcome.plannedContact.permissions.grantedByMe.grants.length).toBe(1);
		expect(outcome.plannedContact.permissions.grantedByPeer.grants.length).toBe(1);

		// establishedAt preserved
		expect(outcome.plannedContact.establishedAt).toBe(PRIOR_ESTABLISHED_AT);

		// expiresAt cleared for active contacts
		expect(outcome.plannedContact.expiresAt).toBeUndefined();

		// connectionId reused
		expect(outcome.plannedContact.connectionId).toBe("existing-conn-001");

		// pure — no trust store writes
		expect(trustStore.addContact).not.toHaveBeenCalled();
		expect(trustStore.updateContact).not.toHaveBeenCalled();
		expect(trustStore.touchContact).not.toHaveBeenCalled();
	});

	// ── active ─────────────────────────────────────────────────
	it("active → plans a touch (plannedContact = existing), result is accepted", async () => {
		const existing = makeContact("active");
		const trustStore = makeMockTrustStore(existing);

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");
		// plannedContact IS the existing contact — caller should touchContact
		expect(outcome.plannedContact.connectionId).toBe("existing-conn-001");
		expect(outcome.existingContact?.status).toBe("active");

		// permissions preserved
		expect(outcome.plannedContact.permissions.grantedByMe.grants.length).toBe(1);
		expect(outcome.plannedContact.permissions.grantedByPeer.grants.length).toBe(1);

		// establishedAt unchanged
		expect(outcome.plannedContact.establishedAt).toBe(PRIOR_ESTABLISHED_AT);

		// pure — no trust store writes
		expect(trustStore.addContact).not.toHaveBeenCalled();
		expect(trustStore.updateContact).not.toHaveBeenCalled();
		expect(trustStore.touchContact).not.toHaveBeenCalled();
	});

	// ── idle ───────────────────────────────────────────────────
	it("idle → plans upgrade to active, preserving permissions and establishedAt", async () => {
		const existing = makeContact("idle");
		const trustStore = makeMockTrustStore(existing);

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");
		expect(outcome.plannedContact.status).toBe("active");

		// permissions preserved
		expect(outcome.plannedContact.permissions.grantedByMe.grants.length).toBe(1);
		expect(outcome.plannedContact.permissions.grantedByPeer.grants.length).toBe(1);

		// establishedAt preserved
		expect(outcome.plannedContact.establishedAt).toBe(PRIOR_ESTABLISHED_AT);

		// connectionId reused
		expect(outcome.plannedContact.connectionId).toBe("existing-conn-001");

		// pure — no trust store writes
		expect(trustStore.addContact).not.toHaveBeenCalled();
		expect(trustStore.updateContact).not.toHaveBeenCalled();
		expect(trustStore.touchContact).not.toHaveBeenCalled();
	});

	// ── stale ──────────────────────────────────────────────────
	it("stale → plans upgrade to active, preserving permissions and establishedAt", async () => {
		const existing = makeContact("stale");
		const trustStore = makeMockTrustStore(existing);

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");
		expect(outcome.plannedContact.status).toBe("active");

		// permissions preserved
		expect(outcome.plannedContact.permissions.grantedByMe.grants.length).toBe(1);
		expect(outcome.plannedContact.permissions.grantedByPeer.grants.length).toBe(1);

		// establishedAt preserved
		expect(outcome.plannedContact.establishedAt).toBe(PRIOR_ESTABLISHED_AT);

		// connectionId reused
		expect(outcome.plannedContact.connectionId).toBe("existing-conn-001");

		// pure — no trust store writes
		expect(trustStore.addContact).not.toHaveBeenCalled();
		expect(trustStore.updateContact).not.toHaveBeenCalled();
		expect(trustStore.touchContact).not.toHaveBeenCalled();
	});

	// ── revoked ────────────────────────────────────────────────
	it("revoked → plans a fresh active contact with empty permissions (clean slate)", async () => {
		const existing = makeContact("revoked");
		const trustStore = makeMockTrustStore(existing);

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");
		expect(outcome.existingContact?.status).toBe("revoked");

		// permissions reset — revoke is a clean slate; prior grants are gone
		expect(isEmptyPermissions(outcome.plannedContact.permissions)).toBe(true);

		// establishedAt is reset (fresh connection)
		expect(outcome.plannedContact.establishedAt).not.toBe(PRIOR_ESTABLISHED_AT);

		// connectionId is reused (the row is overwritten in place)
		expect(outcome.plannedContact.connectionId).toBe("existing-conn-001");

		// planned contact status is active
		expect(outcome.plannedContact.status).toBe("active");

		// pure — no trust store writes
		expect(trustStore.addContact).not.toHaveBeenCalled();
		expect(trustStore.updateContact).not.toHaveBeenCalled();
		expect(trustStore.touchContact).not.toHaveBeenCalled();
	});
});
