import { describe, expect, it, vi } from "vitest";
import { createContactsWriteRoutes } from "../../../src/http/routes/contacts-write.js";

const contact = {
	connectionId: "conn-1",
	peerAgentId: 99,
	peerChain: "eip155:8453",
	peerOwnerAddress: "0x0000000000000000000000000000000000000001",
	peerAgentAddress: "0x0000000000000000000000000000000000000002",
	peerDisplayName: "Alice",
	status: "active" as const,
	permissions: {
		grantedByMe: { updatedAt: "", grants: [] },
		grantedByPeer: { updatedAt: "", grants: [] },
	},
};

function makeFakes() {
	return {
		service: {
			revokeConnection: vi.fn(async () => undefined),
		},
		trustStore: {
			getContacts: vi.fn(async () => [contact]),
			removeContact: vi.fn(async () => undefined),
		},
	};
}

describe("contacts-write routes", () => {
	it("revoke calls service.revokeConnection then trustStore.removeContact", async () => {
		const { service, trustStore } = makeFakes();
		const { revoke } = createContactsWriteRoutes(service as never, trustStore as never);

		const result = await revoke({ connectionId: "conn-1" }, { reason: "moved on" });

		expect(service.revokeConnection).toHaveBeenCalledWith(contact, "moved on");
		expect(trustStore.removeContact).toHaveBeenCalledWith("conn-1");
		expect(result).toEqual({ revoked: true, connectionId: "conn-1", peer: "Alice" });
	});

	it("throws when no contact matches", async () => {
		const { service, trustStore } = makeFakes();
		trustStore.getContacts = vi.fn(async () => []);
		const { revoke } = createContactsWriteRoutes(service as never, trustStore as never);

		await expect(revoke({ connectionId: "missing" }, undefined)).rejects.toThrow(/not found/);
	});

	it("accepts an empty body", async () => {
		const { service, trustStore } = makeFakes();
		const { revoke } = createContactsWriteRoutes(service as never, trustStore as never);

		await revoke({ connectionId: "conn-1" }, undefined);
		expect(service.revokeConnection).toHaveBeenCalledWith(contact, undefined);
	});
});
