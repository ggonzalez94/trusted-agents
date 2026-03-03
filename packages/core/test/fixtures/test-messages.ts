import type { ConversationMessage, JsonRpcRequest } from "../../src/index.js";

export const SAMPLE_JSON_RPC_REQUEST: JsonRpcRequest = {
	jsonrpc: "2.0",
	method: "message/send",
	id: "test-id-001",
	params: {
		message: {
			messageId: "msg-001",
			role: "user",
			parts: [{ kind: "text", text: "Hello agent!" }],
		},
	},
};

export const SAMPLE_CONNECTION_REQUEST: JsonRpcRequest = {
	jsonrpc: "2.0",
	method: "connection/request",
	id: "test-id-002",
	params: {
		from: { agentId: 1, chain: "eip155:1" },
		to: { agentId: 2, chain: "eip155:1" },
		proposedScope: ["general-chat", "scheduling"],
		nonce: "test-nonce-001",
		timestamp: "2025-01-01T00:00:00.000Z",
	},
};

export const SAMPLE_CONVERSATION_MESSAGE: ConversationMessage = {
	timestamp: "2025-06-15T10:30:00.000Z",
	direction: "incoming",
	scope: "general-chat",
	content: "Hello, how can I help you today?",
	humanApprovalRequired: false,
	humanApprovalGiven: null,
};

export const SAMPLE_OUTGOING_MESSAGE: ConversationMessage = {
	timestamp: "2025-06-15T10:31:00.000Z",
	direction: "outgoing",
	scope: "general-chat",
	content: "I need help scheduling a meeting.",
	humanApprovalRequired: true,
	humanApprovalGiven: true,
	humanApprovalAt: "2025-06-15T10:30:30.000Z",
};
