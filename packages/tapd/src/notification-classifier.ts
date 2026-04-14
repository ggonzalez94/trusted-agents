import { randomUUID } from "node:crypto";
import type { TapEvent } from "trusted-agents-core";
import type { TapNotification } from "./notification-queue.js";

/**
 * Convert a typed `TapEvent` into a `TapNotification` suitable for the
 * `NotificationQueue`. Returns `null` for events that should not surface
 * in the operator's pre-prompt context (e.g. plain outbound sends).
 *
 * This is the single decision point for what lands in the
 * `/api/notifications/drain` stream. Host plugins (Hermes, OpenClaw)
 * drain the queue on every pre-prompt hook.
 */
export function classifyEventToNotification(event: TapEvent): TapNotification | null {
	const baseId = `note-${randomUUID()}`;
	switch (event.type) {
		case "action.pending":
			return {
				id: baseId,
				type: "escalation",
				oneLiner: `Pending ${event.kind} request awaiting approval (${event.requestId})`,
				createdAt: event.occurredAt,
				data: {
					requestId: event.requestId,
					kind: event.kind,
					conversationId: event.conversationId,
				},
			};
		case "connection.requested":
			if (event.direction !== "inbound") return null;
			return {
				id: baseId,
				type: "escalation",
				oneLiner: `Inbound connection request from agent #${event.peerAgentId}`,
				createdAt: event.occurredAt,
				data: {
					requestId: event.requestId,
					peerAgentId: event.peerAgentId,
					peerChain: event.peerChain,
				},
			};
		case "message.received":
			return {
				id: baseId,
				type: "info",
				oneLiner: `New message from ${event.peer.peerName || "peer"}: ${truncate(event.text, 80)}`,
				createdAt: event.occurredAt,
				data: {
					conversationId: event.conversationId,
					peerAgentId: event.peer.peerAgentId,
				},
			};
		case "connection.established":
			return {
				id: baseId,
				type: "info",
				oneLiner: `Connection established with ${event.peer.peerName || "peer"}`,
				createdAt: event.occurredAt,
				data: {
					connectionId: event.connectionId,
					peerAgentId: event.peer.peerAgentId,
				},
			};
		case "connection.failed":
			return {
				id: baseId,
				type: "escalation",
				oneLiner: `Connection request ${event.requestId} failed: ${event.error}`,
				createdAt: event.occurredAt,
				data: { requestId: event.requestId },
			};
		case "action.completed":
			return {
				id: baseId,
				type: "info",
				oneLiner: `${event.kind} action ${event.requestId} completed`,
				createdAt: event.occurredAt,
				data: {
					requestId: event.requestId,
					kind: event.kind,
					...(event.txHash ? { txHash: event.txHash } : {}),
				},
			};
		case "action.failed":
			return {
				id: baseId,
				type: "escalation",
				oneLiner: `${event.kind} action ${event.requestId} failed: ${event.error}`,
				createdAt: event.occurredAt,
				data: { requestId: event.requestId, kind: event.kind },
			};
		default:
			return null;
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}
