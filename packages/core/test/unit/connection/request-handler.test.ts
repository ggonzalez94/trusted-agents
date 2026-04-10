import { afterEach, describe, expect, it, vi } from "vitest";
import { handleConnectionRequest } from "../../../src/connection/request-handler.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import type { ProtocolMessage } from "../../../src/transport/interface.js";
import type { ITrustStore } from "../../../src/trust/trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import { ALICE } from "../../fixtures/test-keys.js";

const ALICE_AGENT: ResolvedAgent = {
	agentId: 10,
	chain: "eip155:8453",
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

function makeRequest(overrides: Partial<ProtocolMessage> = {}): ProtocolMessage {
	return {
		jsonrpc: "2.0",
		id: "req-1",
		method: "connection/request",
		params: {
			from: { agentId: 10, chain: "eip155:8453" },
			invite: {
				agentId: 20,
				chain: "eip155:8453",
				expires: 1_893_456_000,
				signature: `0x${"1".repeat(130)}` as `0x${string}`,
			},
			timestamp: "2025-01-01T00:00:00.000Z",
		},
		...overrides,
	};
}

function makeMocks() {
	const resolver: IAgentResolver = {
		resolve: vi.fn<IAgentResolver["resolve"]>().mockResolvedValue(ALICE_AGENT),
		resolveWithCache: vi.fn<IAgentResolver["resolveWithCache"]>().mockResolvedValue(ALICE_AGENT),
	};

	const contacts: Contact[] = [];
	const trustStore: ITrustStore = {
		getContacts: vi.fn<ITrustStore["getContacts"]>().mockResolvedValue(contacts),
		getContact: vi.fn<ITrustStore["getContact"]>().mockResolvedValue(null),
		findByAgentAddress: vi.fn<ITrustStore["findByAgentAddress"]>().mockResolvedValue(null),
		findByAgentId: vi.fn<ITrustStore["findByAgentId"]>().mockResolvedValue(null),
		addContact: vi.fn<ITrustStore["addContact"]>().mockResolvedValue(undefined),
		updateContact: vi.fn<ITrustStore["updateContact"]>().mockResolvedValue(undefined),
		removeContact: vi.fn<ITrustStore["removeContact"]>().mockResolvedValue(undefined),
		touchContact: vi.fn<ITrustStore["touchContact"]>().mockResolvedValue(undefined),
	};

	return { resolver, trustStore };
}

function makeExistingContact(status: Contact["status"]): Contact {
	return {
		connectionId: "existing-conn",
		peerAgentId: 10,
		peerChain: "eip155:8453",
		peerOwnerAddress: ALICE.address,
		peerDisplayName: "Alice",
		peerAgentAddress: ALICE.address,
		permissions: {
			grantedByMe: {
				version: "tap-grants/v1",
				updatedAt: "2025-01-01T00:00:00.000Z",
				grants: [],
			},
			grantedByPeer: {
				version: "tap-grants/v1",
				updatedAt: "2025-01-01T00:00:00.000Z",
				grants: [],
			},
		},
		establishedAt: "2025-01-01T00:00:00.000Z",
		lastContactAt: "2025-01-01T00:00:00.000Z",
		status,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("handleConnectionRequest", () => {
	it("should plan a fresh active contact and NOT write to the trust store (missing peer)", async () => {
		const { resolver, trustStore } = makeMocks();

		const response = await handleConnectionRequest({
			message: makeRequest(),
			resolver,
			trustStore,
			ownAgent: { agentId: 20, chain: "eip155:8453" },
		});

		expect(response.peer).toEqual(ALICE_AGENT);
		expect(response.result.status).toBe("accepted");
		expect(response.result.connectionId).toBeUndefined();

		// plannedContact is a fresh active contact
		expect(response.plannedContact.connectionId).toBeDefined();
		expect(response.plannedContact.peerAgentId).toBe(10);
		expect(response.plannedContact.peerDisplayName).toBe("Alice");
		expect(response.plannedContact.status).toBe("active");
		expect(response.plannedContact.permissions.grantedByMe.grants).toEqual([]);
		expect(response.plannedContact.permissions.grantedByPeer.grants).toEqual([]);

		// No prior contact
		expect(response.existingContact).toBeNull();

		// Pure — no trust store writes
		expect(trustStore.addContact).not.toHaveBeenCalled();
		expect(trustStore.updateContact).not.toHaveBeenCalled();
		expect(trustStore.touchContact).not.toHaveBeenCalled();
	});

	it("should plan an update for an existing non-active contact and NOT write to the trust store", async () => {
		const { resolver, trustStore } = makeMocks();
		const existingContact = makeExistingContact("revoked");
		(trustStore.findByAgentId as ReturnType<typeof vi.fn>).mockResolvedValue(existingContact);

		const response = await handleConnectionRequest({
			message: makeRequest(),
			resolver,
			trustStore,
			ownAgent: { agentId: 20, chain: "eip155:8453" },
		});

		expect(response.result.status).toBe("accepted");
		// plannedContact reuses the existing connectionId
		expect(response.plannedContact.connectionId).toBe("existing-conn");
		// existingContact is the prior revoked contact
		expect(response.existingContact?.connectionId).toBe("existing-conn");
		expect(response.existingContact?.status).toBe("revoked");

		// Pure — no trust store writes
		expect(trustStore.updateContact).not.toHaveBeenCalled();
		expect(trustStore.addContact).not.toHaveBeenCalled();
		expect(trustStore.touchContact).not.toHaveBeenCalled();
	});

	it("should return error for invalid params", async () => {
		const { resolver, trustStore } = makeMocks();

		await expect(
			handleConnectionRequest({
				message: makeRequest({ params: {} }),
				resolver,
				trustStore,
				ownAgent: { agentId: 20, chain: "eip155:8453" },
			}),
		).rejects.toThrow("Invalid connection request parameters");
	});

	it("should return error when resolver fails", async () => {
		const { resolver, trustStore } = makeMocks();
		(resolver.resolveWithCache as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("not found"),
		);

		await expect(
			handleConnectionRequest({
				message: makeRequest(),
				resolver,
				trustStore,
				ownAgent: { agentId: 20, chain: "eip155:8453" },
			}),
		).rejects.toThrow("not found");
	});

	it("should plan a touch for already-connected peers and NOT write to the trust store", async () => {
		const { resolver, trustStore } = makeMocks();
		const existingContact = makeExistingContact("active");
		(trustStore.findByAgentId as ReturnType<typeof vi.fn>).mockResolvedValue(existingContact);

		const response = await handleConnectionRequest({
			message: makeRequest(),
			resolver,
			trustStore,
			ownAgent: { agentId: 20, chain: "eip155:8453" },
		});

		expect(response.result.status).toBe("accepted");
		expect(response.result.connectionId).toBeUndefined();
		// plannedContact IS the existing contact (caller should touchContact)
		expect(response.plannedContact.connectionId).toBe("existing-conn");
		expect(response.existingContact?.connectionId).toBe("existing-conn");
		expect(response.existingContact?.status).toBe("active");

		// Pure — no trust store writes
		expect(trustStore.addContact).not.toHaveBeenCalled();
		expect(trustStore.updateContact).not.toHaveBeenCalled();
		expect(trustStore.touchContact).not.toHaveBeenCalled();
	});
});
