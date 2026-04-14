import type { TapEvent, TapPeerRef } from "trusted-agents-core";
import { describe, expect, it } from "vitest";
import { classifyEventToNotification } from "../../src/notification-classifier.js";

const BASE = {
	id: "evt-1",
	occurredAt: "2026-04-13T00:00:00.000Z",
	identityAgentId: 1,
} as const;

const PEER: TapPeerRef = {
	connectionId: "conn-1",
	peerAgentId: 99,
	peerName: "Bob",
	peerChain: "eip155:8453",
};

describe("classifyEventToNotification", () => {
	it("escalates action.pending events", () => {
		const event: TapEvent = {
			...BASE,
			type: "action.pending",
			conversationId: "conv-1",
			requestId: "req-1",
			kind: "transfer",
			payload: {},
			awaitingDecision: true,
		};
		const note = classifyEventToNotification(event);
		expect(note?.type).toBe("escalation");
		expect(note?.oneLiner).toContain("transfer");
		expect(note?.data?.requestId).toBe("req-1");
	});

	it("escalates inbound connection.requested events", () => {
		const event: TapEvent = {
			...BASE,
			type: "connection.requested",
			requestId: "req-2",
			peerAgentId: 77,
			peerChain: "eip155:8453",
			direction: "inbound",
		};
		const note = classifyEventToNotification(event);
		expect(note?.type).toBe("escalation");
		expect(note?.oneLiner).toContain("#77");
	});

	it("returns null for outbound connection.requested", () => {
		const event: TapEvent = {
			...BASE,
			type: "connection.requested",
			requestId: "req-3",
			peerAgentId: 77,
			peerChain: "eip155:8453",
			direction: "outbound",
		};
		expect(classifyEventToNotification(event)).toBeNull();
	});

	it("produces info notifications for message.received", () => {
		const event: TapEvent = {
			...BASE,
			type: "message.received",
			conversationId: "conv-1",
			peer: PEER,
			messageId: "m-1",
			text: "Hello world",
			scope: "general-chat",
		};
		const note = classifyEventToNotification(event);
		expect(note?.type).toBe("info");
		expect(note?.oneLiner).toContain("Bob");
		expect(note?.oneLiner).toContain("Hello world");
	});

	it("truncates long message text", () => {
		const event: TapEvent = {
			...BASE,
			type: "message.received",
			conversationId: "conv-1",
			peer: PEER,
			messageId: "m-1",
			text: "x".repeat(500),
			scope: "general-chat",
		};
		const note = classifyEventToNotification(event);
		expect(note?.oneLiner.length).toBeLessThan(200);
		expect(note?.oneLiner).toContain("…");
	});

	it("produces info notifications for connection.established", () => {
		const event: TapEvent = {
			...BASE,
			type: "connection.established",
			connectionId: "conn-1",
			peer: PEER,
		};
		const note = classifyEventToNotification(event);
		expect(note?.type).toBe("info");
		expect(note?.oneLiner).toContain("Bob");
	});

	it("escalates connection.failed", () => {
		const event: TapEvent = {
			...BASE,
			type: "connection.failed",
			requestId: "req-fail",
			error: "invite rejected",
		};
		const note = classifyEventToNotification(event);
		expect(note?.type).toBe("escalation");
		expect(note?.oneLiner).toContain("invite rejected");
	});

	it("produces info notifications for action.completed", () => {
		const event: TapEvent = {
			...BASE,
			type: "action.completed",
			conversationId: "conv-1",
			requestId: "req-c",
			kind: "transfer",
			result: {},
			txHash: "0xabc",
			completedAt: BASE.occurredAt,
		};
		const note = classifyEventToNotification(event);
		expect(note?.type).toBe("info");
		expect(note?.data?.txHash).toBe("0xabc");
	});

	it("escalates action.failed", () => {
		const event: TapEvent = {
			...BASE,
			type: "action.failed",
			conversationId: "conv-1",
			requestId: "req-f",
			kind: "scheduling",
			error: "no matching slot",
		};
		const note = classifyEventToNotification(event);
		expect(note?.type).toBe("escalation");
		expect(note?.oneLiner).toContain("no matching slot");
	});

	it("returns null for events that should not surface", () => {
		const sentEvent: TapEvent = {
			...BASE,
			type: "message.sent",
			conversationId: "conv-1",
			peer: PEER,
			messageId: "m-out",
			text: "hello",
			scope: "general-chat",
		};
		expect(classifyEventToNotification(sentEvent)).toBeNull();

		const resolved: TapEvent = {
			...BASE,
			type: "pending.resolved",
			requestId: "req-1",
			decision: "approved",
			decidedBy: "operator",
		};
		expect(classifyEventToNotification(resolved)).toBeNull();
	});
});
