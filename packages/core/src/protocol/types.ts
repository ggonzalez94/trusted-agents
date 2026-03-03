export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	method: string;
	id: JsonRpcId;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: JsonRpcErrorObject;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface TextPart {
	kind: "text";
	text: string;
}

export interface DataPart {
	kind: "data";
	data: Record<string, unknown>;
}

export type MessagePart = TextPart | DataPart;

export interface TrustedAgentMetadata {
	connectionId: string;
	conversationId: string;
	scope: string;
	requiresHumanApproval: boolean;
}

export interface Message {
	messageId: string;
	role: "user" | "agent";
	parts: MessagePart[];
	metadata?: {
		trustedAgent?: TrustedAgentMetadata;
	};
}

export interface AgentIdentifier {
	agentId: number;
	chain: string;
	ownerAddress?: `0x${string}`;
}

export interface ConnectionRequestParams {
	from: AgentIdentifier;
	to: AgentIdentifier;
	proposedScope: string[];
	message?: string;
	nonce: string;
	protocolVersion?: string;
	timestamp: string;
}

export interface ConnectionAcceptParams {
	connectionId: string;
	from: AgentIdentifier;
	to: AgentIdentifier;
	acceptedScope: string[];
	requestNonce: string;
	timestamp: string;
}

export interface ConnectionRejectParams {
	from: AgentIdentifier;
	to: AgentIdentifier;
	reason?: string;
	nonce: string;
	timestamp: string;
}

export interface MessageSendParams {
	message: Message;
}

export interface AgentCard {
	name: string;
	description: string;
	url: string;
	capabilities: string[];
	protocols: string[];
	version?: string;
	defaultInputModes?: string[];
	defaultOutputModes?: string[];
	skills?: Array<{
		id: string;
		name: string;
		description?: string;
		tags?: string[];
	}>;
	trustedAgentProtocol?: {
		version: string;
		agentAddress: `0x${string}`;
		capabilities: string[];
	};
}
