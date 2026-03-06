import { describe, expect, it } from "vitest";
import { generateMarkdownTranscript } from "../../../src/conversation/transcript.js";
import type { ConversationLog } from "../../../src/conversation/types.js";

describe("generateMarkdownTranscript", () => {
	const baseLog: ConversationLog = {
		conversationId: "conv-001",
		connectionId: "conn-001",
		peerAgentId: 2,
		peerDisplayName: "Bob's Agent",
		startedAt: "2025-06-15T10:30:00.000Z",
		lastMessageAt: "2025-06-15T10:32:00.000Z",
		status: "active",
		messages: [
			{
				timestamp: "2025-06-15T10:30:00.000Z",
				direction: "incoming",
				scope: "general-chat",
				content: "Hello there!",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{
				timestamp: "2025-06-15T10:31:00.000Z",
				direction: "outgoing",
				scope: "general-chat",
				content: "Hi! How can I help?",
				humanApprovalRequired: true,
				humanApprovalGiven: true,
				humanApprovalAt: "2025-06-15T10:30:45.000Z",
			},
		],
	};

	it("should produce a markdown transcript with header", () => {
		const transcript = generateMarkdownTranscript(baseLog);

		expect(transcript).toContain("## Bob's Agent | Conversation | 2025-06-15");
	});

	it("should include incoming messages with left arrow", () => {
		const transcript = generateMarkdownTranscript(baseLog);

		expect(transcript).toContain("\u2190"); // left arrow
		expect(transcript).toContain("Hello there!");
	});

	it("should include outgoing messages with right arrow", () => {
		const transcript = generateMarkdownTranscript(baseLog);

		expect(transcript).toContain("\u2192"); // right arrow
		expect(transcript).toContain("Hi! How can I help?");
	});

	it("should include human approval annotation when given", () => {
		const transcript = generateMarkdownTranscript(baseLog);

		expect(transcript).toContain("\u2705"); // checkmark
		expect(transcript).toContain("approved by owner");
	});

	it("should use topic in header when provided", () => {
		const logWithTopic: ConversationLog = {
			...baseLog,
			topic: "Meeting Scheduling",
		};

		const transcript = generateMarkdownTranscript(logWithTopic);

		expect(transcript).toContain("Meeting Scheduling");
		expect(transcript).not.toContain("| Conversation |");
	});

	it("should format timestamps as HH:MM", () => {
		const transcript = generateMarkdownTranscript(baseLog);

		expect(transcript).toContain("[10:30]");
		expect(transcript).toContain("[10:31]");
	});

	it("should handle an empty messages array", () => {
		const emptyLog: ConversationLog = {
			...baseLog,
			messages: [],
		};

		const transcript = generateMarkdownTranscript(emptyLog);

		expect(transcript).toContain("## Bob's Agent");
		// Should still produce the header but no message lines
		expect(transcript.split("\n").length).toBeGreaterThanOrEqual(2);
	});

	it("should sort messages by timestamp before rendering", () => {
		const outOfOrderLog: ConversationLog = {
			...baseLog,
			messages: [...baseLog.messages].reverse(),
		};

		const transcript = generateMarkdownTranscript(outOfOrderLog);
		expect(transcript.indexOf("Hello there!")).toBeLessThan(
			transcript.indexOf("Hi! How can I help?"),
		);
	});
});
