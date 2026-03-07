import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTrustStore } from "../../../src/trust/file-trust-store.js";
import { BOB } from "../../fixtures/test-keys.js";
import { createTestContact } from "../../helpers/test-agent.js";

describe("FileTrustStore", () => {
	let tmpDir: string;
	let store: FileTrustStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "trust-store-test-"));
		store = new FileTrustStore(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
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
		const store2 = new FileTrustStore(tmpDir);
		const contacts = await store2.getContacts();
		expect(contacts).toHaveLength(1);
		expect(contacts[0]!.peerDisplayName).toBe("Bob's Agent");
	});

	it("should normalize legacy permission maps when loading persisted contacts", async () => {
		await writeFile(
			join(tmpDir, "contacts.json"),
			JSON.stringify(
				{
					contacts: [
						{
							...createTestContact(),
							permissions: {
								"message/send": true,
								"transfer/request": {
									asset: "native",
									maxAmount: "0.001",
								},
							},
						},
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const contacts = await store.getContacts();
		expect(contacts[0]?.permissions.grantedByMe.grants).toHaveLength(0);
		expect(contacts[0]?.permissions.grantedByPeer.grants).toHaveLength(2);
		expect(contacts[0]?.permissions.grantedByPeer.grants[0]?.grantId).toBe("legacy:message/send");
		expect(contacts[0]?.permissions.grantedByPeer.grants[1]?.constraints).toMatchObject({
			asset: "native",
			maxAmount: "0.001",
		});
	});
});
