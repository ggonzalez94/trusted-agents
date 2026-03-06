import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileConversationLogger,
	FileTrustStore,
	createEmptyPermissionState,
} from "trusted-agents-core";
import type { Contact, ConversationMessage } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeConversations } from "../../src/commands/conversations.js";

describe("executeConversations", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "openclaw-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should return empty list when no conversations exist", async () => {
		const result = await executeConversations({ dataDir: tmpDir });

		expect(result.conversations).toEqual([]);
		expect(result.transcript).toBeUndefined();
	});

	it("should list conversations with message counts", async () => {
		const logger = new FileConversationLogger(tmpDir);

		const msg1: ConversationMessage = {
			timestamp: "2025-01-15T10:15:00.000Z",
			direction: "outgoing",
			scope: "message/send",
			content: "Hello there!",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};

		const msg2: ConversationMessage = {
			timestamp: "2025-01-15T10:16:00.000Z",
			direction: "incoming",
			scope: "message/send",
			content: "Hi! How can I help?",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};

		await logger.logMessage("conv-abc", msg1, {
			connectionId: "conn-abc",
			peerAgentId: 42,
			peerDisplayName: "TravelBot",
		});
		await logger.logMessage("conv-abc", msg2);

		const result = await executeConversations({ dataDir: tmpDir });

		expect(result.conversations).toHaveLength(1);
		expect(result.conversations[0]!.conversationId).toBe("conv-abc");
		expect(result.conversations[0]!.messageCount).toBe(2);
	});

	it("should generate transcript for a specific conversation", async () => {
		const logger = new FileConversationLogger(tmpDir);

		const msg: ConversationMessage = {
			timestamp: "2025-01-15T10:15:00.000Z",
			direction: "outgoing",
			scope: "message/send",
			content: "Hello there!",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};

		await logger.logMessage("conv-xyz", msg, {
			connectionId: "conn-xyz",
			peerAgentId: 99,
			peerDisplayName: "SupportBot",
		});

		const result = await executeConversations({
			dataDir: tmpDir,
			conversationId: "conv-xyz",
		});

		expect(result.transcript).toBeTruthy();
		expect(result.transcript).toContain("Hello there!");
		expect(result.conversations).toHaveLength(1);
	});

	it("should filter conversations by peer name", async () => {
		const store = new FileTrustStore(tmpDir);
		const contact: Contact = {
			connectionId: "conn-123",
			peerAgentId: 42,
			peerChain: "base-sepolia",
			peerOwnerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
			peerDisplayName: "TravelBot",
			peerAgentAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
			permissions: createEmptyPermissionState("2025-01-15T10:30:00.000Z"),
			establishedAt: "2025-01-01T00:00:00.000Z",
			lastContactAt: "2025-01-15T10:30:00.000Z",
			status: "active",
		};
		await store.addContact(contact);

		const result = await executeConversations({
			dataDir: tmpDir,
			withName: "NonExistentBot",
		});

		expect(result.conversations).toEqual([]);
	});

	it("should return empty transcript for non-existent conversation", async () => {
		const result = await executeConversations({
			dataDir: tmpDir,
			conversationId: "non-existent",
		});

		expect(result.conversations).toEqual([]);
		expect(result.transcript).toBeUndefined();
	});
});
