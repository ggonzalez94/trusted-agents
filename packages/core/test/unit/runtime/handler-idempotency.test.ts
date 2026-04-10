/**
 * Table-driven idempotency tests for handleConnectionRequest.
 * Covers every row of spec §5.2 from the connection-flow-simplification design doc.
 *
 * Each case seeds a FileTrustStore with the initial contact state (or no contact for
 * "missing"), invokes handleConnectionRequest, then asserts on the trust store's
 * post-call state.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleConnectionRequest } from "../../../src/connection/request-handler.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { createGrantSet } from "../../../src/permissions/types.js";
import { FileTrustStore } from "../../../src/trust/file-trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import { ALICE } from "../../fixtures/test-keys.js";
import { useTempDirs } from "../../helpers/temp-dir.js";

const { track: trackDir } = useTempDirs();

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

async function createStore(): Promise<FileTrustStore> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-idempotency-"));
	trackDir(dataDir);
	return new FileTrustStore(dataDir);
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

/** Seed a contact with the given status into the store. Returns the seeded contact. */
async function seedContact(
	store: FileTrustStore,
	status: Contact["status"],
	extra: Partial<Contact> = {},
): Promise<Contact> {
	const contact: Contact = {
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
	await store.addContact(contact);
	return contact;
}

/** Checks that the given ContactPermissionState looks like createEmptyPermissionState output. */
function isEmptyPermissions(permissions: Contact["permissions"]): boolean {
	return (
		permissions.grantedByMe.grants.length === 0 && permissions.grantedByPeer.grants.length === 0
	);
}

// ──────────────────────────────────────────────────────────────
// §5.2 idempotency table
// ──────────────────────────────────────────────────────────────

describe("handleConnectionRequest — §5.2 idempotency table", () => {
	// ── missing ────────────────────────────────────────────────
	it("missing → creates a fresh active contact with empty permissions", async () => {
		const store = await createStore();
		// No seed — trust store is empty.

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore: store,
			ownAgent: OWN_AGENT,
		});

		// result is accepted
		expect(outcome.result.status).toBe("accepted");

		// post-call: contact is active
		const saved = await store.findByAgentId(PEER_AGENT_ID, PEER_CHAIN);
		expect(saved).not.toBeNull();
		expect(saved!.status).toBe("active");

		// permissions are empty (fresh slate)
		expect(isEmptyPermissions(saved!.permissions)).toBe(true);

		// outcome contact matches what was written
		expect(outcome.contact?.status).toBe("active");
		expect(outcome.contact?.connectionId).toBe(saved!.connectionId);
	});

	// ── connecting ─────────────────────────────────────────────
	it("connecting → upgrades to active, preserving permissions and establishedAt", async () => {
		const store = await createStore();
		await seedContact(store, "connecting", { expiresAt: "2099-01-01T00:00:00.000Z" });

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore: store,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");

		const saved = await store.findByAgentId(PEER_AGENT_ID, PEER_CHAIN);
		expect(saved).not.toBeNull();
		expect(saved!.status).toBe("active");

		// permissions preserved
		expect(saved!.permissions.grantedByMe.grants.length).toBe(1);
		expect(saved!.permissions.grantedByPeer.grants.length).toBe(1);

		// establishedAt preserved
		expect(saved!.establishedAt).toBe(PRIOR_ESTABLISHED_AT);

		// expiresAt is NOT carried forward to the active contact
		expect(saved!.expiresAt).toBeUndefined();

		// connectionId reused
		expect(saved!.connectionId).toBe("existing-conn-001");
	});

	// ── active ─────────────────────────────────────────────────
	it("active → touches lastContactAt, preserves everything else, result is accepted", async () => {
		const store = await createStore();
		await seedContact(store, "active");

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore: store,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");

		const saved = await store.findByAgentId(PEER_AGENT_ID, PEER_CHAIN);
		expect(saved).not.toBeNull();
		expect(saved!.status).toBe("active");

		// permissions preserved (touchContact only updates lastContactAt)
		expect(saved!.permissions.grantedByMe.grants.length).toBe(1);
		expect(saved!.permissions.grantedByPeer.grants.length).toBe(1);

		// establishedAt unchanged
		expect(saved!.establishedAt).toBe(PRIOR_ESTABLISHED_AT);

		// connectionId unchanged
		expect(saved!.connectionId).toBe("existing-conn-001");
	});

	// ── idle ───────────────────────────────────────────────────
	it("idle → upgrades to active, preserving permissions and establishedAt", async () => {
		const store = await createStore();
		await seedContact(store, "idle");

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore: store,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");

		const saved = await store.findByAgentId(PEER_AGENT_ID, PEER_CHAIN);
		expect(saved).not.toBeNull();
		expect(saved!.status).toBe("active");

		// permissions preserved
		expect(saved!.permissions.grantedByMe.grants.length).toBe(1);
		expect(saved!.permissions.grantedByPeer.grants.length).toBe(1);

		// establishedAt preserved
		expect(saved!.establishedAt).toBe(PRIOR_ESTABLISHED_AT);

		// connectionId reused
		expect(saved!.connectionId).toBe("existing-conn-001");
	});

	// ── stale ──────────────────────────────────────────────────
	it("stale → upgrades to active, preserving permissions and establishedAt", async () => {
		const store = await createStore();
		await seedContact(store, "stale");

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore: store,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");

		const saved = await store.findByAgentId(PEER_AGENT_ID, PEER_CHAIN);
		expect(saved).not.toBeNull();
		expect(saved!.status).toBe("active");

		// permissions preserved
		expect(saved!.permissions.grantedByMe.grants.length).toBe(1);
		expect(saved!.permissions.grantedByPeer.grants.length).toBe(1);

		// establishedAt preserved
		expect(saved!.establishedAt).toBe(PRIOR_ESTABLISHED_AT);

		// connectionId reused
		expect(saved!.connectionId).toBe("existing-conn-001");
	});

	// ── revoked ────────────────────────────────────────────────
	it("revoked → creates a fresh active contact with empty permissions (clean slate)", async () => {
		const store = await createStore();
		await seedContact(store, "revoked");

		const outcome = await handleConnectionRequest({
			message: makeRequest(),
			resolver: makeMockResolver(),
			trustStore: store,
			ownAgent: OWN_AGENT,
		});

		expect(outcome.result.status).toBe("accepted");

		const saved = await store.findByAgentId(PEER_AGENT_ID, PEER_CHAIN);
		expect(saved).not.toBeNull();
		expect(saved!.status).toBe("active");

		// permissions reset — revoke is a clean slate; prior grants are gone
		expect(isEmptyPermissions(saved!.permissions)).toBe(true);

		// establishedAt is reset (fresh connection)
		expect(saved!.establishedAt).not.toBe(PRIOR_ESTABLISHED_AT);

		// connectionId is reused (the row is overwritten, not a new row)
		expect(saved!.connectionId).toBe("existing-conn-001");

		// outcome contact reflects the fresh state
		expect(outcome.contact?.status).toBe("active");
		expect(isEmptyPermissions(outcome.contact!.permissions)).toBe(true);
	});
});
