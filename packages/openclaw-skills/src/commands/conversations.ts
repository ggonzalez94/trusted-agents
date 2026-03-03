import { FileConversationLogger, FileTrustStore } from "trusted-agents-core";

export interface ConversationEntry {
	conversationId: string;
	peerName: string;
	topic?: string;
	lastMessage: string;
	messageCount: number;
}

export interface ConversationsResult {
	conversations: ConversationEntry[];
	transcript?: string;
}

export interface ConversationsCommandOptions {
	dataDir: string;
	withName?: string;
	conversationId?: string;
}

export async function executeConversations(
	options: ConversationsCommandOptions,
): Promise<ConversationsResult> {
	const { dataDir, withName, conversationId } = options;
	const logger = new FileConversationLogger(dataDir);

	if (conversationId) {
		const transcript = await logger.generateTranscript(conversationId);
		const log = await logger.getConversation(conversationId);

		return {
			conversations: log
				? [
						{
							conversationId: log.conversationId,
							peerName: log.peerDisplayName,
							topic: log.topic,
							lastMessage: log.lastMessageAt,
							messageCount: log.messages.length,
						},
					]
				: [],
			transcript: transcript || undefined,
		};
	}

	let filter: { connectionId?: string } | undefined;

	if (withName) {
		const trustStore = new FileTrustStore(dataDir);
		const contacts = await trustStore.getContacts();
		const match = contacts.find((c) => c.peerDisplayName.toLowerCase() === withName.toLowerCase());
		if (match) {
			filter = { connectionId: match.connectionId };
		} else {
			return { conversations: [] };
		}
	}

	const logs = await logger.listConversations(filter);

	const conversations: ConversationEntry[] = logs.map((log) => ({
		conversationId: log.conversationId,
		peerName: log.peerDisplayName,
		topic: log.topic,
		lastMessage: log.lastMessageAt,
		messageCount: log.messages.length,
	}));

	return { conversations };
}
