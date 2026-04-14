import { randomUUID } from "node:crypto";
import type { TapEvent } from "trusted-agents-core";
import type { TapNotification, TapNotificationType } from "./notification-queue.js";

export function classifyEventToNotification(event: TapEvent): TapNotification | null {
	const note = (
		type: TapNotificationType,
		oneLiner: string,
		data: Record<string, unknown>,
	): TapNotification => ({
		id: `note-${randomUUID()}`,
		type,
		oneLiner,
		createdAt: event.occurredAt,
		data,
	});

	switch (event.type) {
		case "action.pending":
			return note(
				"escalation",
				`Pending ${event.kind} request awaiting approval (${event.requestId})`,
				{
					requestId: event.requestId,
					kind: event.kind,
					conversationId: event.conversationId,
				},
			);
		case "connection.requested":
			if (event.direction !== "inbound") return null;
			return note("escalation", `Inbound connection request from agent #${event.peerAgentId}`, {
				requestId: event.requestId,
				peerAgentId: event.peerAgentId,
				peerChain: event.peerChain,
			});
		case "message.received":
			return note(
				"info",
				`New message from ${event.peer.peerName || "peer"}: ${truncate(event.text, 80)}`,
				{
					conversationId: event.conversationId,
					peerAgentId: event.peer.peerAgentId,
				},
			);
		case "connection.established":
			return note("info", `Connection established with ${event.peer.peerName || "peer"}`, {
				connectionId: event.connectionId,
				peerAgentId: event.peer.peerAgentId,
			});
		case "connection.failed":
			return note("escalation", `Connection request ${event.requestId} failed: ${event.error}`, {
				requestId: event.requestId,
			});
		case "action.completed":
			return note("info", `${event.kind} action ${event.requestId} completed`, {
				requestId: event.requestId,
				kind: event.kind,
				...(event.txHash ? { txHash: event.txHash } : {}),
			});
		case "action.failed":
			return note("escalation", `${event.kind} action ${event.requestId} failed: ${event.error}`, {
				requestId: event.requestId,
				kind: event.kind,
			});
		default:
			return null;
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}
