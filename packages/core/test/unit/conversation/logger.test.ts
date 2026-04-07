import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileConversationLogger } from "../../../src/conversation/logger.js";
import type { ConversationMessage } from "../../../src/index.js";

const SAMPLE_CONVERSATION_MESSAGE: ConversationMessage = {
	timestamp: "2025-06-15T10:30:00.000Z",
	direction: "incoming",
	scope: "general-chat",
	content: "Hello, how can I help you today?",
	humanApprovalRequired: false,
	humanApprovalGiven: null,
};

const SAMPLE_OUTGOING_MESSAGE: ConversationMessage = {
	timestamp: "2025-06-15T10:31:00.000Z",
	direction: "outgoing",
	scope: "general-chat",
	content: "I need help scheduling a meeting.",
	humanApprovalRequired: true,
	humanApprovalGiven: true,
	humanApprovalAt: "2025-06-15T10:30:30.000Z",
};

describe("FileConversationLogger", () => {
	let tmpDir: string;
	let logger: FileConversationLogger;
	const context = {
		connectionId: "conn-001",
		peerAgentId: 42,
		peerDisplayName: "Bob's Agent",
	};

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "conv-logger-test-"));
		logger = new FileConversationLogger(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should log a message and create a new conversation", async () => {
		await logger.logMessage("conv-001", SAMPLE_CONVERSATION_MESSAGE, context);

		const conv = await logger.getConversation("conv-001");
		expect(conv).not.toBeNull();
		expect(conv!.conversationId).toBe("conv-001");
		expect(conv!.messages).toHaveLength(1);
		expect(conv!.messages[0]!.content).toBe("Hello, how can I help you today?");
	});

	it("should append messages to an existing conversation", async () => {
		await logger.logMessage("conv-001", SAMPLE_CONVERSATION_MESSAGE, context);
		await logger.logMessage("conv-001", SAMPLE_OUTGOING_MESSAGE);

		const conv = await logger.getConversation("conv-001");
		expect(conv!.messages).toHaveLength(2);
		expect(conv!.messages[1]!.direction).toBe("outgoing");
	});

	it("should return null for a nonexistent conversation", async () => {
		const conv = await logger.getConversation("nonexistent");
		expect(conv).toBeNull();
	});

	it("should list all conversations", async () => {
		await logger.logMessage("conv-001", SAMPLE_CONVERSATION_MESSAGE, context);
		await logger.logMessage("conv-002", SAMPLE_OUTGOING_MESSAGE, context);

		const list = await logger.listConversations();
		expect(list).toHaveLength(2);
	});

	it("should list conversations with empty result when none exist", async () => {
		const list = await logger.listConversations();
		expect(list).toEqual([]);
	});

	it("should update lastMessageAt when logging a new message", async () => {
		await logger.logMessage("conv-001", SAMPLE_CONVERSATION_MESSAGE, context);
		const conv1 = await logger.getConversation("conv-001");
		const first = conv1!.lastMessageAt;

		await logger.logMessage("conv-001", SAMPLE_OUTGOING_MESSAGE);
		const conv2 = await logger.getConversation("conv-001");

		expect(conv2!.lastMessageAt).toBe(SAMPLE_OUTGOING_MESSAGE.timestamp);
		expect(conv2!.lastMessageAt).not.toBe(first);
	});

	it("should generate a transcript for a conversation", async () => {
		await logger.logMessage("conv-001", SAMPLE_CONVERSATION_MESSAGE, context);
		await logger.logMessage("conv-001", SAMPLE_OUTGOING_MESSAGE);

		const transcript = await logger.generateTranscript("conv-001");

		expect(transcript).toContain("Bob's Agent");
		expect(transcript).toContain("Hello, how can I help you today?");
		expect(transcript).toContain("I need help scheduling a meeting.");
	});

	it("should return empty string for transcript of nonexistent conversation", async () => {
		const transcript = await logger.generateTranscript("nonexistent");
		expect(transcript).toBe("");
	});
});
