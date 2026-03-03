import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTrustStore } from "trusted-agents-core";
import type { Contact } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeContacts } from "../../src/commands/contacts.js";

describe("executeContacts", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "openclaw-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should return empty list when no contacts exist", async () => {
		const result = await executeContacts({ dataDir: tmpDir });

		expect(result.contacts).toEqual([]);
	});

	it("should return formatted contacts", async () => {
		const store = new FileTrustStore(tmpDir);
		const contact: Contact = {
			connectionId: "conn-123",
			peerAgentId: 42,
			peerChain: "base-sepolia",
			peerOwnerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
			peerDisplayName: "TestBot",
			peerEndpoint: "https://testbot.example.com/a2a",
			peerAgentAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
			permissions: { "message/send": true, "message/action-request": true },
			establishedAt: "2025-01-01T00:00:00.000Z",
			lastContactAt: "2025-01-15T10:30:00.000Z",
			status: "active",
		};

		await store.addContact(contact);

		const result = await executeContacts({ dataDir: tmpDir });

		expect(result.contacts).toHaveLength(1);
		expect(result.contacts[0]).toEqual({
			name: "TestBot",
			agentId: 42,
			chain: "base-sepolia",
			status: "active",
			permissions: ["message/send", "message/action-request"],
			lastContact: "2025-01-15T10:30:00.000Z",
		});
	});

	it("should filter out false permissions", async () => {
		const store = new FileTrustStore(tmpDir);
		const contact: Contact = {
			connectionId: "conn-456",
			peerAgentId: 7,
			peerChain: "ethereum",
			peerOwnerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
			peerDisplayName: "OldBot",
			peerEndpoint: "https://oldbot.example.com/a2a",
			peerAgentAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
			permissions: { "message/send": false, "message/action-request": true },
			establishedAt: "2024-12-01T00:00:00.000Z",
			lastContactAt: "2024-12-01T00:00:00.000Z",
			status: "revoked",
		};

		await store.addContact(contact);

		const result = await executeContacts({ dataDir: tmpDir });

		expect(result.contacts[0]!.permissions).toEqual(["message/action-request"]);
		expect(result.contacts[0]!.status).toBe("revoked");
	});
});
