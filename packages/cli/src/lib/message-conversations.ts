import { createHash } from "node:crypto";
import {
	MESSAGE_ACTION_REQUEST,
	MESSAGE_ACTION_RESPONSE,
	MESSAGE_SEND,
	assertSafeFileComponent,
	createJsonRpcRequest,
	createMessage,
	nowISO,
} from "trusted-agents-core";
import type {
	Contact,
	ConversationMessage,
	IConversationLogger,
	JsonRpcRequest,
	Message,
	MessagePart,
	ProtocolMessage,
	TrustedAgentMetadata,
} from "trusted-agents-core";

const LOGGABLE_MESSAGE_METHODS = new Set<string>([
	MESSAGE_SEND,
	MESSAGE_ACTION_REQUEST,
	MESSAGE_ACTION_RESPONSE,
]);

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

export function buildOutgoingMessageRequest(contact: Contact, text: string): JsonRpcRequest {
	const conversationId = resolveConversationId(contact);

	return createJsonRpcRequest(MESSAGE_SEND, {
		message: createMessage(text, {
			trustedAgent: {
				connectionId: contact.connectionId,
				conversationId,
				scope: MESSAGE_SEND,
				requiresHumanApproval: false,
			},
		}),
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
