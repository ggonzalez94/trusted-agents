import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteConversationLogger } from "../../../src/conversation/sqlite-logger.js";
import type { ConversationMessage } from "../../../src/conversation/types.js";

function makeMessage(timestamp: string, content: string): ConversationMessage {
	return {
		timestamp,
		direction: "outgoing",
		scope: "default",
		content,
		humanApprovalRequired: false,
		humanApprovalGiven: null,
	};
}

describe("SqliteConversationLogger", () => {
	let dataDir: string;
	let logger: SqliteConversationLogger;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "sqlite-conv-test-"));
		logger = new SqliteConversationLogger(dataDir);
	});

	afterEach(async () => {
		logger.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("creates a new conversation on first message", async () => {
		await logger.logMessage(
			"conv-1",
			{
				timestamp: "2026-04-01T00:00:00.000Z",
				direction: "outgoing",
				scope: "default",
				content: "hello",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{
				connectionId: "conn-1",
				peerAgentId: 42,
				peerDisplayName: "Alice",
			},
		);

		const log = await logger.getConversation("conv-1");
		expect(log?.messages).toHaveLength(1);
		expect(log?.peerDisplayName).toBe("Alice");
		expect(log?.startedAt).toBe("2026-04-01T00:00:00.000Z");
		expect(log?.lastMessageAt).toBe("2026-04-01T00:00:00.000Z");
		expect(log?.status).toBe("active");
	});

	it("throws when creating a new conversation without context", async () => {
		await expect(
			logger.logMessage("conv-orphan", makeMessage("2026-04-01T00:00:00.000Z", "x")),
		).rejects.toThrow(/context is required/i);
	});

	it("appends to an existing conversation", async () => {
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "first"), {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		});
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:01:00.000Z", "second"));

		const log = await logger.getConversation("conv-1");
		expect(log?.messages.map((m) => m.content)).toEqual(["first", "second"]);
		expect(log?.lastMessageAt).toBe("2026-04-01T00:01:00.000Z");
	});

	it("dedupes by messageId+direction", async () => {
		const ctx = {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		};
		await logger.logMessage(
			"conv-1",
			{ ...makeMessage("2026-04-01T00:00:00.000Z", "first"), messageId: "m1" },
			ctx,
		);
		await logger.logMessage("conv-1", {
			...makeMessage("2026-04-01T00:00:00.000Z", "first"),
			messageId: "m1",
		});
		await logger.logMessage("conv-1", {
			...makeMessage("2026-04-01T00:00:00.000Z", "first"),
			messageId: "m1",
		});

		const log = await logger.getConversation("conv-1");
		expect(log?.messages).toHaveLength(1);
	});

	it("does not dedupe when messageId differs by direction", async () => {
		const ctx = {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		};
		await logger.logMessage(
			"conv-1",
			{ ...makeMessage("2026-04-01T00:00:00.000Z", "out"), messageId: "m1" },
			ctx,
		);
		await logger.logMessage("conv-1", {
			timestamp: "2026-04-01T00:00:01.000Z",
			direction: "incoming",
			scope: "default",
			content: "in",
			messageId: "m1",
			humanApprovalRequired: false,
			humanApprovalGiven: null,
		});

		const log = await logger.getConversation("conv-1");
		expect(log?.messages).toHaveLength(2);
	});

	it("updates topic when context provides it", async () => {
		const ctx = {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		};
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "a"), ctx);
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:01:00.000Z", "b"), {
			...ctx,
			topic: "New topic",
		});
		const log = await logger.getConversation("conv-1");
		expect(log?.topic).toBe("New topic");
	});

	it("returns null for unknown conversation", async () => {
		expect(await logger.getConversation("nope")).toBeNull();
	});

	it("listConversations sorts by lastMessageAt DESC", async () => {
		await logger.logMessage("conv-a", makeMessage("2026-04-01T00:00:00.000Z", "x"), {
			connectionId: "ca",
			peerAgentId: 1,
			peerDisplayName: "A",
		});
		await logger.logMessage("conv-b", makeMessage("2026-04-03T00:00:00.000Z", "x"), {
			connectionId: "cb",
			peerAgentId: 2,
			peerDisplayName: "B",
		});
		await logger.logMessage("conv-c", makeMessage("2026-04-02T00:00:00.000Z", "x"), {
			connectionId: "cc",
			peerAgentId: 3,
			peerDisplayName: "C",
		});

		const all = await logger.listConversations();
		expect(all.map((c) => c.conversationId)).toEqual(["conv-b", "conv-c", "conv-a"]);
	});

	it("listConversations filters by connectionId", async () => {
		await logger.logMessage("conv-a", makeMessage("2026-04-01T00:00:00.000Z", "x"), {
			connectionId: "ca",
			peerAgentId: 1,
			peerDisplayName: "A",
		});
		await logger.logMessage("conv-b", makeMessage("2026-04-02T00:00:00.000Z", "x"), {
			connectionId: "cb",
			peerAgentId: 2,
			peerDisplayName: "B",
		});

		const filtered = await logger.listConversations({ connectionId: "cb" });
		expect(filtered.map((c) => c.conversationId)).toEqual(["conv-b"]);
	});

	it("listConversations returns [] when no conversations exist", async () => {
		expect(await logger.listConversations()).toEqual([]);
	});

	it("markRead updates lastReadAt", async () => {
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "x"), {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		});

		await logger.markRead("conv-1", "2026-04-01T00:01:00.000Z");
		const log = await logger.getConversation("conv-1");
		expect(log?.lastReadAt).toBe("2026-04-01T00:01:00.000Z");
	});

	it("markRead is a no-op for unknown conversations", async () => {
		await logger.markRead("nope", "2026-04-01T00:00:00.000Z");
		expect(await logger.getConversation("nope")).toBeNull();
	});

	it("generateTranscript returns markdown for an existing conversation", async () => {
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "hello from test"), {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		});
		const md = await logger.generateTranscript("conv-1");
		expect(md).toContain("hello from test");
		expect(md).toContain("Alice");
	});

	it("generateTranscript returns empty string for unknown conversations", async () => {
		expect(await logger.generateTranscript("nope")).toBe("");
	});

	it("persists data across instances", async () => {
		await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "persisted"), {
			connectionId: "conn-1",
			peerAgentId: 42,
			peerDisplayName: "Alice",
		});
		logger.close();

		const second = new SqliteConversationLogger(dataDir);
		const log = await second.getConversation("conv-1");
		expect(log?.messages[0]?.content).toBe("persisted");
		second.close();
	});

	it("preserves humanApproval* fields through a round-trip", async () => {
		await logger.logMessage(
			"conv-1",
			{
				timestamp: "2026-04-01T00:00:00.000Z",
				direction: "outgoing",
				scope: "general-chat",
				content: "needs approval",
				humanApprovalRequired: true,
				humanApprovalGiven: true,
				humanApprovalAt: "2026-04-01T00:00:30.000Z",
			},
			{
				connectionId: "conn-1",
				peerAgentId: 42,
				peerDisplayName: "Alice",
			},
		);

		const log = await logger.getConversation("conv-1");
		expect(log?.messages[0]?.humanApprovalRequired).toBe(true);
		expect(log?.messages[0]?.humanApprovalGiven).toBe(true);
		expect(log?.messages[0]?.humanApprovalAt).toBe("2026-04-01T00:00:30.000Z");
	});

	it("close() is idempotent", () => {
		logger.close();
		expect(() => logger.close()).not.toThrow();
	});
});
