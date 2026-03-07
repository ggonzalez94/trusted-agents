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
	chain: "eip155:84532",
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
			from: { agentId: 10, chain: "eip155:84532" },
			to: { agentId: 20, chain: "eip155:84532" },
			connectionId: "conn-req-1",
			nonce: "test-nonce",
			protocolVersion: "1.0",
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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("handleConnectionRequest", () => {
	it("should accept a valid connection request", async () => {
		const { resolver, trustStore } = makeMocks();
		const approve = vi.fn(async () => true);

		const response = await handleConnectionRequest({
			message: makeRequest(),
			resolver,
			trustStore,
			ownAgent: { agentId: 20, chain: "eip155:84532" },
			approve,
		});

		expect(response.peer).toEqual(ALICE_AGENT);
		expect(response.result.status).toBe("accepted");
		expect(response.result.connectionId).toBe("conn-req-1");
		expect(response.contact?.connectionId).toBe("conn-req-1");
		expect(approve).toHaveBeenCalledWith(ALICE_AGENT, undefined);

		expect(trustStore.addContact).toHaveBeenCalledOnce();
		const stored = (trustStore.addContact as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Contact;
		expect(stored.peerAgentId).toBe(10);
		expect(stored.peerDisplayName).toBe("Alice");
		expect(stored.status).toBe("active");
		expect(stored.permissions.grantedByMe.grants).toEqual([]);
		expect(stored.permissions.grantedByPeer.grants).toEqual([]);
	});

	it("should reject when approval callback returns false", async () => {
		const { resolver, trustStore } = makeMocks();

		const response = await handleConnectionRequest({
			message: makeRequest(),
			resolver,
			trustStore,
			ownAgent: { agentId: 20, chain: "eip155:84532" },
			approve: async () => false,
		});

		expect(response.result.status).toBe("rejected");
		expect(response.result.reason).toBe("Connection rejected by agent");
		expect(response.contact).toBeNull();

		expect(trustStore.addContact).not.toHaveBeenCalled();
	});

	it("should return error for invalid params", async () => {
		const { resolver, trustStore } = makeMocks();

		await expect(
			handleConnectionRequest({
				message: makeRequest({ params: {} }),
				resolver,
				trustStore,
				ownAgent: { agentId: 20, chain: "eip155:84532" },
				approve: async () => true,
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
				ownAgent: { agentId: 20, chain: "eip155:84532" },
				approve: async () => true,
			}),
		).rejects.toThrow("not found");
	});

	it("should return accept with existing connectionId for already-connected peers", async () => {
		const { resolver, trustStore } = makeMocks();
		const existingContact: Contact = {
			connectionId: "existing-conn",
			peerAgentId: 10,
			peerChain: "eip155:84532",
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
			status: "active",
		};
		(trustStore.findByAgentId as ReturnType<typeof vi.fn>).mockResolvedValue(existingContact);

		const response = await handleConnectionRequest({
			message: makeRequest(),
			resolver,
			trustStore,
			ownAgent: { agentId: 20, chain: "eip155:84532" },
			approve: async () => true,
		});

		expect(response.result.status).toBe("accepted");
		expect(response.result.connectionId).toBe("existing-conn");
		expect(response.contact?.connectionId).toBe("existing-conn");

		// Should not add a duplicate contact
		expect(trustStore.addContact).not.toHaveBeenCalled();
	});
});
