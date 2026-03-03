import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileConversationLogger } from "../../src/conversation/logger.js";
import type { ConversationMessage } from "../../src/conversation/types.js";

describe("Conversation logging integration", () => {
	let tmpDir: string;
	let logger: FileConversationLogger;
	const conversationId = "conv-int-001";
	const context = {
		connectionId: "conn-int-001",
		peerAgentId: 7,
		peerDisplayName: "Scheduling Bot",
	};

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "conv-int-test-"));
		logger = new FileConversationLogger(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should log a multi-message conversation and produce a correct transcript", async () => {
		const messages: ConversationMessage[] = [
			{
				timestamp: "2025-06-15T10:30:00.000Z",
				direction: "incoming",
				scope: "general-chat",
				content: "Hello! I'm looking for help with scheduling.",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{
				timestamp: "2025-06-15T10:31:00.000Z",
				direction: "outgoing",
				scope: "general-chat",
				content: "Hi! I'd be happy to help. What would you like to schedule?",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{
				timestamp: "2025-06-15T10:32:00.000Z",
				direction: "incoming",
				scope: "scheduling",
				content: "Can you book a meeting with team leads for Friday?",
				humanApprovalRequired: true,
				humanApprovalGiven: null,
			},
			{
				timestamp: "2025-06-15T10:33:00.000Z",
				direction: "outgoing",
				scope: "scheduling",
				content: "I've scheduled a meeting for Friday at 10am with all team leads.",
				humanApprovalRequired: true,
				humanApprovalGiven: true,
				humanApprovalAt: "2025-06-15T10:32:30.000Z",
			},
		];

		for (const msg of messages) {
			await logger.logMessage(conversationId, msg, context);
		}

		const conv = await logger.getConversation(conversationId);
		expect(conv).not.toBeNull();
		expect(conv!.conversationId).toBe(conversationId);
		expect(conv!.messages).toHaveLength(4);
		expect(conv!.startedAt).toBe("2025-06-15T10:30:00.000Z");
		expect(conv!.lastMessageAt).toBe("2025-06-15T10:33:00.000Z");

		expect(conv!.messages[0]!.content).toBe("Hello! I'm looking for help with scheduling.");
		expect(conv!.messages[2]!.humanApprovalRequired).toBe(true);
		expect(conv!.messages[3]!.humanApprovalGiven).toBe(true);

		const transcript = await logger.generateTranscript(conversationId);

		expect(transcript).toContain("2025-06-15");
		expect(transcript).toContain("[10:30]");
		expect(transcript).toContain("[10:31]");
		expect(transcript).toContain("[10:32]");
		expect(transcript).toContain("[10:33]");

		expect(transcript).toContain("\u2190");
		expect(transcript).toContain("\u2192");

		expect(transcript).toContain("\u2705");
		expect(transcript).toContain("approved by owner");

		expect(transcript).toContain("Hello! I'm looking for help with scheduling.");
		expect(transcript).toContain("Hi! I'd be happy to help.");
		expect(transcript).toContain("Can you book a meeting");
		expect(transcript).toContain("I've scheduled a meeting");
	});

	it("should list multiple conversations and filter by connectionId", async () => {
		const msg1: ConversationMessage = {
			timestamp: "2025-06-15T10:00:00.000Z",
			direction: "incoming",
			scope: "general-chat",
			content: "First conversation message",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};

		const msg2: ConversationMessage = {
			timestamp: "2025-06-15T11:00:00.000Z",
			direction: "incoming",
			scope: "research",
			content: "Second conversation message",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};

		await logger.logMessage("conv-a", msg1, {
			connectionId: "conn-a",
			peerAgentId: 1,
			peerDisplayName: "Agent A",
		});
		await logger.logMessage("conv-b", msg2, {
			connectionId: "conn-b",
			peerAgentId: 2,
			peerDisplayName: "Agent B",
		});

		const all = await logger.listConversations();
		expect(all).toHaveLength(2);

		const convA = await logger.getConversation("conv-a");
		const convB = await logger.getConversation("conv-b");
		expect(convA!.messages[0]!.content).toBe("First conversation message");
		expect(convB!.messages[0]!.content).toBe("Second conversation message");
	});

	it("should persist conversation data across logger instances", async () => {
		const msg: ConversationMessage = {
			timestamp: "2025-06-15T10:00:00.000Z",
			direction: "outgoing",
			scope: "general-chat",
			content: "Persistent message",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		};

		await logger.logMessage("conv-persist", msg, context);

		const logger2 = new FileConversationLogger(tmpDir);
		const conv = await logger2.getConversation("conv-persist");

		expect(conv).not.toBeNull();
		expect(conv!.messages).toHaveLength(1);
		expect(conv!.messages[0]!.content).toBe("Persistent message");
	});
});
