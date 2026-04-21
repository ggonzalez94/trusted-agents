export interface ConversationMessage {
	messageId?: string;
	timestamp: string;
	direction: "incoming" | "outgoing";
	scope: string;
	content: string;
	humanApprovalRequired: boolean;
	humanApprovalGiven: boolean | null;
	humanApprovalAt?: string;
}

export type ConversationStatus = "active" | "completed" | "archived";

export interface ConversationLog {
	conversationId: string;
	connectionId: string;
	peerAgentId: number;
	peerDisplayName: string;
	topic?: string;
	startedAt: string;
	lastMessageAt: string;
	lastReadAt?: string;
	status: ConversationStatus;
	messages: ConversationMessage[];
}
