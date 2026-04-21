import { type Contact, type ITrustStore, createEmptyPermissionState } from "trusted-agents-core";
import { describe, expect, it } from "vitest";
import { createContactsRoutes } from "../../../src/http/routes/contacts.js";

function makeContact(overrides: Partial<Contact> = {}): Contact {
	return {
		connectionId: "conn-1",
		peerAgentId: 42,
		peerChain: "eip155:8453",
		peerAgentAddress: "0xabc0000000000000000000000000000000000abc",
		peerOwnerAddress: "0xdef0000000000000000000000000000000000def",
		peerDisplayName: "Alice",
		permissions: createEmptyPermissionState(),
		establishedAt: "2026-04-01T00:00:00.000Z",
		lastContactAt: "2026-04-01T00:00:00.000Z",
		status: "active",
		...overrides,
	};
}

class FakeTrustStore implements Pick<ITrustStore, "getContacts" | "getContact"> {
	constructor(private readonly contacts: Contact[]) {}

	async getContacts(): Promise<Contact[]> {
		return this.contacts;
	}

	async getContact(id: string): Promise<Contact | null> {
		return this.contacts.find((c) => c.connectionId === id) ?? null;
	}
}

describe("contacts routes", () => {
	it("lists all contacts", async () => {
		const store = new FakeTrustStore([
			makeContact({ connectionId: "a" }),
			makeContact({ connectionId: "b" }),
		]);
		const { list } = createContactsRoutes(store as never);

		const result = await list({}, undefined);
		expect(result).toHaveLength(2);
		expect((result as Contact[])[0].connectionId).toBe("a");
	});

	it("returns a single contact by connection id", async () => {
		const store = new FakeTrustStore([makeContact({ connectionId: "a" })]);
		const { get } = createContactsRoutes(store as never);

		const result = await get({ connectionId: "a" }, undefined);
		expect((result as Contact).connectionId).toBe("a");
	});

	it("returns null when contact does not exist", async () => {
		const store = new FakeTrustStore([]);
		const { get } = createContactsRoutes(store as never);

		const result = await get({ connectionId: "missing" }, undefined);
		expect(result).toBeNull();
	});
});
