import type { ConversationLog, IConversationLogger } from "trusted-agents-core";
import { describe, expect, it, vi } from "vitest";
import { createConversationsRoutes } from "../../../src/http/routes/conversations.js";

function makeLog(overrides: Partial<ConversationLog> = {}): ConversationLog {
	return {
		conversationId: "conv-1",
		connectionId: "conn-1",
		peerAgentId: 42,
		peerDisplayName: "Alice",
		startedAt: "2026-04-01T00:00:00.000Z",
		lastMessageAt: "2026-04-02T00:00:00.000Z",
		status: "active",
		messages: [],
		...overrides,
	};
}

class FakeLogger implements IConversationLogger {
	constructor(private readonly logs: ConversationLog[]) {}

	async logMessage(): Promise<void> {}
	async getConversation(id: string): Promise<ConversationLog | null> {
		return this.logs.find((l) => l.conversationId === id) ?? null;
	}
	async listConversations(): Promise<ConversationLog[]> {
		return this.logs;
	}
	async generateTranscript(): Promise<string> {
		return "";
	}
	async markRead(): Promise<void> {}
}

describe("conversations routes", () => {
	it("lists conversations sorted by lastMessageAt desc", async () => {
		const logger = new FakeLogger([
			makeLog({ conversationId: "a", lastMessageAt: "2026-04-01T00:00:00.000Z" }),
			makeLog({ conversationId: "b", lastMessageAt: "2026-04-03T00:00:00.000Z" }),
			makeLog({ conversationId: "c", lastMessageAt: "2026-04-02T00:00:00.000Z" }),
		]);
		const { list } = createConversationsRoutes(logger);

		const result = (await list({}, undefined)) as Array<{ conversationId: string }>;
		expect(result.map((r) => r.conversationId)).toEqual(["b", "c", "a"]);
	});

	it("returns full conversation by id", async () => {
		const logger = new FakeLogger([makeLog({ conversationId: "a" })]);
		const { get } = createConversationsRoutes(logger);

		const result = await get({ id: "a" }, undefined);
		expect((result as ConversationLog).conversationId).toBe("a");
	});

	it("returns null for missing conversation", async () => {
		const logger = new FakeLogger([]);
		const { get } = createConversationsRoutes(logger);

		const result = await get({ id: "missing" }, undefined);
		expect(result).toBeNull();
	});

	it("delegates mark-read to the logger", async () => {
		const logger = new FakeLogger([makeLog({ conversationId: "a" })]);
		const spy = vi.spyOn(logger, "markRead");
		const { markRead } = createConversationsRoutes(logger);

		await markRead({ id: "a" }, undefined);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][0]).toBe("a");
	});
});
