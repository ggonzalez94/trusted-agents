import { beforeEach, describe, expect, it } from "vitest";
import { FileTrustStore } from "../../../src/trust/file-trust-store.js";
import { BOB } from "../../fixtures/test-keys.js";
import { useTempDir } from "../../helpers/temp-dir.js";
import { createTestContact } from "../../helpers/test-agent.js";

describe("FileTrustStore", () => {
	const dir = useTempDir("trust-store-test");
	let store: FileTrustStore;

	beforeEach(() => {
		store = new FileTrustStore(dir.path);
	});

	it("should return empty contacts list initially", async () => {
		const contacts = await store.getContacts();
		expect(contacts).toEqual([]);
	});

	it("should add and retrieve a contact", async () => {
		const contact = createTestContact();
		await store.addContact(contact);

		const contacts = await store.getContacts();
		expect(contacts).toHaveLength(1);
		expect(contacts[0]!.connectionId).toBe("test-connection-001");
	});

	it("should get a contact by connectionId", async () => {
		const contact = createTestContact();
		await store.addContact(contact);

		const found = await store.getContact("test-connection-001");
		expect(found).not.toBeNull();
		expect(found!.peerDisplayName).toBe("Bob's Agent");
	});

	it("should return null for a nonexistent connectionId", async () => {
		const found = await store.getContact("nonexistent");
		expect(found).toBeNull();
	});

	it("should find a contact by agent address", async () => {
		const contact = createTestContact();
		await store.addContact(contact);

		const found = await store.findByAgentAddress(BOB.address);
		expect(found).not.toBeNull();
		expect(found!.connectionId).toBe("test-connection-001");
	});

	it("should find a contact by agentId and chain", async () => {
		const contact = createTestContact();
		await store.addContact(contact);

		const found = await store.findByAgentId(2, "eip155:1");
		expect(found).not.toBeNull();
		expect(found!.peerDisplayName).toBe("Bob's Agent");
	});

	it("should throw when adding a duplicate connectionId", async () => {
		const contact = createTestContact();
		await store.addContact(contact);

		await expect(store.addContact(contact)).rejects.toThrow("already exists");
	});

	it("should update a contact", async () => {
		const contact = createTestContact();
		await store.addContact(contact);

		await store.updateContact("test-connection-001", { peerDisplayName: "Updated Agent" });

		const found = await store.getContact("test-connection-001");
		expect(found!.peerDisplayName).toBe("Updated Agent");
	});

	it("should throw when updating a nonexistent contact", async () => {
		await expect(store.updateContact("nonexistent", { peerDisplayName: "Nope" })).rejects.toThrow(
			"not found",
		);
	});

	it("should remove a contact", async () => {
		const contact = createTestContact();
		await store.addContact(contact);

		await store.removeContact("test-connection-001");

		const contacts = await store.getContacts();
		expect(contacts).toHaveLength(0);
	});

	it("should throw when removing a nonexistent contact", async () => {
		await expect(store.removeContact("nonexistent")).rejects.toThrow("not found");
	});

	it("should touch a contact and update lastContactAt", async () => {
		const contact = createTestContact();
		await store.addContact(contact);

		const before = (await store.getContact("test-connection-001"))!.lastContactAt;
		// Small delay to ensure timestamp changes
		await new Promise((r) => setTimeout(r, 10));
		await store.touchContact("test-connection-001");
		const after = (await store.getContact("test-connection-001"))!.lastContactAt;

		expect(after).not.toBe(before);
	});

	it("should persist data across store instances", async () => {
		const contact = createTestContact();
		await store.addContact(contact);

		// Create a new store instance pointing to the same directory
		const store2 = new FileTrustStore(dir.path);
		const contacts = await store2.getContacts();
		expect(contacts).toHaveLength(1);
		expect(contacts[0]!.peerDisplayName).toBe("Bob's Agent");
	});

	it("should deactivate stale active contact when adding a new one with the same address", async () => {
		const oldContact = createTestContact({
			connectionId: "old-connection",
			peerAgentId: 100,
			peerDisplayName: "Old Agent",
		});
		await store.addContact(oldContact);

		const newContact = createTestContact({
			connectionId: "new-connection",
			peerAgentId: 200,
			peerDisplayName: "New Agent",
		});
		await store.addContact(newContact);

		const contacts = await store.getContacts();
		expect(contacts).toHaveLength(2);

		const old = contacts.find((c) => c.connectionId === "old-connection");
		expect(old!.status).toBe("stale");

		const fresh = contacts.find((c) => c.connectionId === "new-connection");
		expect(fresh!.status).toBe("active");

		// findByAgentAddress should now return the new active contact without throwing
		const found = await store.findByAgentAddress(BOB.address, "eip155:1");
		expect(found!.connectionId).toBe("new-connection");
	});

	it("should not deactivate contacts on a different chain", async () => {
		const contactBase = createTestContact({
			connectionId: "base-connection",
			peerChain: "eip155:8453",
		});
		await store.addContact(contactBase);

		const contactTaiko = createTestContact({
			connectionId: "taiko-connection",
			peerChain: "eip155:167000",
		});
		await store.addContact(contactTaiko);

		const contacts = await store.getContacts();
		expect(contacts.filter((c) => c.status === "active")).toHaveLength(2);
	});

	it("should round-trip a connecting contact with expiresAt through addContact and findByAgentId", async () => {
		const expiresAt = "2026-12-31T23:59:59.000Z";
		const contact = createTestContact({
			connectionId: "connecting-001",
			peerAgentId: 99,
			peerChain: "eip155:8453",
			status: "connecting",
			expiresAt,
		});
		await store.addContact(contact);

		const found = await store.findByAgentId(99, "eip155:8453");
		expect(found).not.toBeNull();
		expect(found!.status).toBe("connecting");
		expect(found!.expiresAt).toBe(expiresAt);
	});
});
