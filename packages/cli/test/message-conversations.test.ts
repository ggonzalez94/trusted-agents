import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileConversationLogger,
	MESSAGE_SEND,
	appendConversationLog,
	buildConversationLogEntry,
	buildOutgoingActionRequest,
	buildOutgoingMessageRequest,
	createEmptyPermissionState,
	findUniqueContactForAgentId,
} from "trusted-agents-core";
import type { Contact, ProtocolMessage } from "trusted-agents-core";
import { DEFAULT_MESSAGE_SCOPE } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findContactForPeer } from "../src/lib/message-conversations.js";

const CONTACT: Contact = {
	connectionId: "conn-alice-001",
	peerAgentId: 42,
	peerChain: "eip155:8453",
	peerOwnerAddress: "0x1111111111111111111111111111111111111111",
	peerDisplayName: "Alice",
	peerAgentAddress: "0x2222222222222222222222222222222222222222",
	permissions: createEmptyPermissionState("2026-03-05T18:00:00.000Z"),
	establishedAt: "2026-03-05T18:00:00.000Z",
	lastContactAt: "2026-03-05T18:00:00.000Z",
	status: "active",
};

describe("message conversation helpers", () => {
	let tmpDir: string;
	let logger: FileConversationLogger;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-cli-conv-"));
		logger = new FileConversationLogger(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("finds a contact by display name or agent id", () => {
		expect(findContactForPeer([CONTACT], "Alice")).toEqual(CONTACT);
		expect(findContactForPeer([CONTACT], "42")).toEqual(CONTACT);
		expect(findContactForPeer([CONTACT], "missing")).toBeUndefined();
	});

	it("finds a unique active contact for an inbound agent id", () => {
		expect(findUniqueContactForAgentId([CONTACT], 42)).toEqual(CONTACT);
		expect(
			findUniqueContactForAgentId(
				[
					CONTACT,
					{
						...CONTACT,
						connectionId: "conn-alice-002",
						peerChain: "eip155:1",
					},
				],
				42,
			),
		).toBeUndefined();
	});

	it("builds outgoing message requests with trusted-agent metadata", () => {
		const request = buildOutgoingMessageRequest(CONTACT, "Hello Alice");
		const params = request.params as { message: { metadata?: { trustedAgent?: unknown } } };
		const metadata = params.message.metadata?.trustedAgent as {
			connectionId: string;
			conversationId: string;
			scope: string;
			requiresHumanApproval: boolean;
		};

		expect(request.method).toBe(MESSAGE_SEND);
		expect(metadata.connectionId).toBe(CONTACT.connectionId);
		expect(metadata.conversationId).toBe(CONTACT.connectionId);
		expect(metadata.scope).toBe(DEFAULT_MESSAGE_SCOPE);
		expect(metadata.requiresHumanApproval).toBe(false);
	});

	it("builds a log entry from the message payload", () => {
		const request = buildOutgoingMessageRequest(CONTACT, "Hello Alice");
		const entry = buildConversationLogEntry(
			CONTACT,
			request,
			"outgoing",
			"2026-03-05T19:00:00.000Z",
		);

		expect(entry).toEqual({
			conversationId: CONTACT.connectionId,
			message: {
				messageId: expect.any(String),
				timestamp: "2026-03-05T19:00:00.000Z",
				direction: "outgoing",
				scope: DEFAULT_MESSAGE_SCOPE,
				content: "Hello Alice",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
		});
	});

	it("builds outgoing action requests with structured data and approval metadata", () => {
		const request = buildOutgoingActionRequest(
			CONTACT,
			"Send funds",
			{ type: "transfer/request", asset: "native", amount: "0.1" },
			"transfer/request",
		);
		const params = request.params as {
			message: { parts: Array<{ kind: string }>; metadata?: { trustedAgent?: unknown } };
		};
		const metadata = params.message.metadata?.trustedAgent as {
			scope: string;
			requiresHumanApproval: boolean;
		};

		expect(request.method).toBe("action/request");
		expect(params.message.parts).toHaveLength(2);
		expect(metadata.scope).toBe("transfer/request");
		expect(metadata.requiresHumanApproval).toBe(true);
	});

	it("falls back to the connection id when incoming metadata uses an unsafe conversation id", () => {
		const request: ProtocolMessage = {
			jsonrpc: "2.0",
			id: "msg-unsafe-001",
			method: MESSAGE_SEND,
			params: {
				message: {
					messageId: "message-unsafe-001",
					role: "agent",
					parts: [{ kind: "text", text: "Unsafe id fallback" }],
					metadata: {
						trustedAgent: {
							connectionId: CONTACT.connectionId,
							conversationId: "../escape",
							scope: "general-chat",
							requiresHumanApproval: true,
						},
					},
				},
			},
		};

		const entry = buildConversationLogEntry(
			CONTACT,
			request,
			"incoming",
			"2026-03-05T19:05:00.000Z",
		);

		expect(entry).toEqual({
			conversationId: CONTACT.connectionId,
			message: {
				messageId: "message-unsafe-001",
				timestamp: "2026-03-05T19:05:00.000Z",
				direction: "incoming",
				scope: "general-chat",
				content: "Unsafe id fallback",
				humanApprovalRequired: true,
				humanApprovalGiven: null,
			},
		});
	});

	it("ignores alternate inbound metadata conversation ids and stays on the contact conversation", () => {
		const request: ProtocolMessage = {
			jsonrpc: "2.0",
			id: "msg-thread-001",
			method: MESSAGE_SEND,
			params: {
				message: {
					messageId: "message-thread-001",
					role: "agent",
					parts: [{ kind: "text", text: "Pinned thread" }],
					metadata: {
						trustedAgent: {
							connectionId: CONTACT.connectionId,
							conversationId: "peer-thread-123",
							scope: MESSAGE_SEND,
							requiresHumanApproval: false,
						},
					},
				},
			},
		};

		const entry = buildConversationLogEntry(CONTACT, request, "incoming");
		expect(entry?.conversationId).toBe(CONTACT.connectionId);
	});

	it("derives a safe fallback conversation id when the contact connection id is unsafe", async () => {
		const unsafeContact: Contact = {
			...CONTACT,
			connectionId: "../remote supplied id",
		};
		const request = buildOutgoingMessageRequest(unsafeContact, "Safe fallback");
		const entry = buildConversationLogEntry(
			unsafeContact,
			request,
			"outgoing",
			"2026-03-05T19:06:00.000Z",
		);

		expect(entry).not.toBeNull();
		expect(entry!.conversationId).toMatch(/^conv-[0-9a-f]{16}$/);

		await appendConversationLog(
			logger,
			unsafeContact,
			request,
			"outgoing",
			"2026-03-05T19:06:00.000Z",
		);

		const logs = await logger.listConversations({ connectionId: unsafeContact.connectionId });
		expect(logs).toHaveLength(1);
		expect(logs[0]!.messages[0]!.content).toBe("Safe fallback");
	});

	it("skips non-message requests", () => {
		const request: ProtocolMessage = {
			jsonrpc: "2.0",
			id: "not-loggable-001",
			method: "connection/request",
			params: {},
		};

		expect(buildConversationLogEntry(CONTACT, request, "incoming")).toBeNull();
	});

	it("skips malformed non-text parts instead of throwing", () => {
		const request: ProtocolMessage = {
			jsonrpc: "2.0",
			id: "bad-data-001",
			method: MESSAGE_SEND,
			params: {
				message: {
					messageId: "message-bad-data-001",
					role: "agent",
					parts: [{ kind: "data" }],
				},
			},
		};

		expect(buildConversationLogEntry(CONTACT, request, "incoming")).toBeNull();
	});

	it("persists a transcript from outgoing and incoming requests", async () => {
		const outgoing = buildOutgoingMessageRequest(CONTACT, "Ping from CLI");
		const incoming: ProtocolMessage = {
			jsonrpc: "2.0",
			id: "msg-in-001",
			method: MESSAGE_SEND,
			params: {
				message: {
					messageId: "message-in-001",
					role: "agent",
					parts: [{ kind: "text", text: "Pong from peer" }],
					metadata: {
						trustedAgent: {
							connectionId: CONTACT.connectionId,
							conversationId: CONTACT.connectionId,
							scope: MESSAGE_SEND,
							requiresHumanApproval: false,
						},
					},
				},
			},
		};

		await appendConversationLog(logger, CONTACT, outgoing, "outgoing", "2026-03-05T19:10:00.000Z");
		await appendConversationLog(logger, CONTACT, incoming, "incoming", "2026-03-05T19:11:00.000Z");

		const conversation = await logger.getConversation(CONTACT.connectionId);
		const transcript = await logger.generateTranscript(CONTACT.connectionId);

		expect(conversation).not.toBeNull();
		expect(conversation!.messages).toHaveLength(2);
		expect(conversation!.messages[0]!.content).toBe("Ping from CLI");
		expect(conversation!.messages[1]!.content).toBe("Pong from peer");
		expect(transcript).toContain("Ping from CLI");
		expect(transcript).toContain("Pong from peer");
	});

	it("deduplicates repeated logs for the same incoming message id", async () => {
		const incoming: ProtocolMessage = {
			jsonrpc: "2.0",
			id: "msg-duplicate-001",
			method: MESSAGE_SEND,
			params: {
				message: {
					messageId: "message-duplicate-001",
					role: "agent",
					parts: [{ kind: "text", text: "Only once" }],
					metadata: {
						trustedAgent: {
							connectionId: CONTACT.connectionId,
							conversationId: CONTACT.connectionId,
							scope: MESSAGE_SEND,
							requiresHumanApproval: false,
						},
					},
				},
			},
		};

		await appendConversationLog(logger, CONTACT, incoming, "incoming", "2026-03-05T19:15:00.000Z");
		await appendConversationLog(logger, CONTACT, incoming, "incoming", "2026-03-05T19:15:01.000Z");

		const conversation = await logger.getConversation(CONTACT.connectionId);
		expect(conversation).not.toBeNull();
		expect(conversation!.messages).toHaveLength(1);
		expect(conversation!.messages[0]!.messageId).toBe("message-duplicate-001");
	});
});
