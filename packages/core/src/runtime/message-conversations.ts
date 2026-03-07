import { createHash } from "node:crypto";
import { assertSafeFileComponent, generateNonce, nowISO } from "../common/index.js";
import type { IConversationLogger } from "../conversation/logger.js";
import type { ConversationMessage } from "../conversation/types.js";
import { createJsonRpcRequest } from "../protocol/messages.js";
import { ACTION_REQUEST, ACTION_RESULT, MESSAGE_SEND } from "../protocol/methods.js";
import type {
	JsonRpcRequest,
	Message,
	MessagePart,
	TrustedAgentMetadata,
} from "../protocol/types.js";
import type { ProtocolMessage } from "../transport/interface.js";
import type { Contact } from "../trust/types.js";

export const DEFAULT_MESSAGE_SCOPE = "general-chat";

const LOGGABLE_MESSAGE_METHODS = new Set<string>([MESSAGE_SEND, ACTION_REQUEST, ACTION_RESULT]);

export function findContactForPeer(contacts: Contact[], peer: string): Contact | undefined {
	const agentIdNum = Number.parseInt(peer, 10);

	return contacts.find(
		(contact) =>
			contact.peerDisplayName.toLowerCase() === peer.toLowerCase() ||
			(!Number.isNaN(agentIdNum) && contact.peerAgentId === agentIdNum),
	);
}

export function findUniqueContactForAgentId(
	contacts: Contact[],
	agentId: number,
): Contact | undefined {
	const matches = contacts.filter(
		(contact) => contact.peerAgentId === agentId && contact.status === "active",
	);
	return matches.length === 1 ? matches[0] : undefined;
}

export function buildOutgoingMessageRequest(
	contact: Contact,
	text: string,
	scope = DEFAULT_MESSAGE_SCOPE,
): JsonRpcRequest {
	return buildOutgoingRequest(contact, MESSAGE_SEND, [{ kind: "text", text }], scope, false);
}

export function buildOutgoingActionRequest(
	contact: Contact,
	text: string,
	data: Record<string, unknown>,
	scope: string,
): JsonRpcRequest {
	return buildOutgoingRequest(
		contact,
		ACTION_REQUEST,
		[
			{ kind: "text", text },
			{ kind: "data", data },
		],
		scope,
		true,
	);
}

export function buildOutgoingActionResult(
	contact: Contact,
	requestId: string,
	text: string,
	data: Record<string, unknown>,
	scope: string,
	status: "completed" | "rejected" | "failed",
): JsonRpcRequest {
	return createJsonRpcRequest(ACTION_RESULT, {
		requestId,
		status,
		timestamp: nowISO(),
		message: buildProtocolMessage(
			contact,
			[
				{ kind: "text", text },
				{ kind: "data", data },
			],
			scope,
			false,
		),
	});
}

export function buildConversationLogEntry(
	contact: Contact,
	request: ProtocolMessage,
	direction: ConversationMessage["direction"],
	timestamp: string = nowISO(),
): { conversationId: string; message: ConversationMessage } | null {
	if (!LOGGABLE_MESSAGE_METHODS.has(request.method)) {
		return null;
	}

	const message = extractProtocolMessage(request);
	if (!message) {
		return null;
	}

	const content = extractMessageContent(message.parts);
	if (!content) {
		return null;
	}

	const metadata = extractTrustedAgentMetadata(message);

	return {
		conversationId: resolveConversationId(contact),
		message: {
			messageId: extractMessageId(message) ?? String(request.id),
			timestamp,
			direction,
			scope: resolveScope(request, metadata),
			content,
			humanApprovalRequired: metadata?.requiresHumanApproval === true,
			humanApprovalGiven: null,
		},
	};
}

export async function appendConversationLog(
	logger: IConversationLogger,
	contact: Contact,
	request: ProtocolMessage,
	direction: ConversationMessage["direction"],
	timestamp?: string,
): Promise<void> {
	const entry = buildConversationLogEntry(contact, request, direction, timestamp);
	if (!entry) {
		return;
	}

	await logger.logMessage(entry.conversationId, entry.message, {
		connectionId: contact.connectionId,
		peerAgentId: contact.peerAgentId,
		peerDisplayName: contact.peerDisplayName,
	});
}

function buildOutgoingRequest(
	contact: Contact,
	method: string,
	parts: MessagePart[],
	scope: string,
	requiresHumanApproval: boolean,
): JsonRpcRequest {
	return createJsonRpcRequest(method, {
		message: buildProtocolMessage(contact, parts, scope, requiresHumanApproval),
	});
}

function buildProtocolMessage(
	contact: Contact,
	parts: MessagePart[],
	scope: string,
	requiresHumanApproval: boolean,
): Message {
	const conversationId = resolveConversationId(contact);

	return {
		messageId: generateNonce(),
		role: "user" as const,
		parts,
		metadata: {
			trustedAgent: {
				connectionId: contact.connectionId,
				conversationId,
				scope,
				requiresHumanApproval,
			},
		},
	};
}

function extractMessageId(message: Message): string | undefined {
	return typeof message.messageId === "string" && message.messageId.length > 0
		? message.messageId
		: undefined;
}

function extractProtocolMessage(request: ProtocolMessage): Message | null {
	if (typeof request.params !== "object" || request.params === null) {
		return null;
	}

	const message = (request.params as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) {
		return null;
	}

	const parts = (message as { parts?: unknown }).parts;
	if (!Array.isArray(parts)) {
		return null;
	}

	return message as Message;
}

function extractTrustedAgentMetadata(message: Message): Partial<TrustedAgentMetadata> | undefined {
	if (typeof message.metadata !== "object" || message.metadata === null) {
		return undefined;
	}

	const metadata = message.metadata.trustedAgent;
	if (typeof metadata !== "object" || metadata === null) {
		return undefined;
	}

	return metadata as Partial<TrustedAgentMetadata>;
}

function extractMessageContent(parts: MessagePart[]): string | null {
	const fragments = parts
		.flatMap((part) => {
			if (part.kind === "text") {
				return typeof part.text === "string" && part.text.length > 0 ? [part.text] : [];
			}

			try {
				const serialized = JSON.stringify(part.data);
				return typeof serialized === "string" && serialized.length > 0 ? [serialized] : [];
			} catch {
				return [];
			}
		})
		.filter((fragment) => fragment.length > 0);

	return fragments.length > 0 ? fragments.join("\n\n") : null;
}

function resolveConversationId(contact: Contact): string {
	const safeConnectionId = toSafeConversationId(contact.connectionId);
	if (safeConnectionId) {
		return safeConnectionId;
	}

	return `conv-${createHash("sha256").update(contact.connectionId).digest("hex").slice(0, 16)}`;
}

function resolveScope(request: ProtocolMessage, metadata?: Partial<TrustedAgentMetadata>): string {
	return typeof metadata?.scope === "string" && metadata.scope.length > 0
		? metadata.scope
		: request.method;
}

function toSafeConversationId(value: string | undefined): string | null {
	if (typeof value !== "string" || value.length === 0) {
		return null;
	}

	try {
		assertSafeFileComponent(value, "conversationId");
		return value;
	} catch {
		return null;
	}
}
