/**
 * Shapes mirroring the tapd HTTP API surface.
 *
 * Source of truth: `packages/tapd/src/http/routes/*` and
 * `packages/core/src/runtime/event-types.ts`. These types intentionally narrow
 * the structural fields the UI needs; if tapd returns extra keys the UI
 * gracefully ignores them. If tapd renames a field, the UI fails at typecheck.
 */

// ──────────────────────────────────────────────────────────────
// Identity (GET /api/identity → IdentityInfo)
// ──────────────────────────────────────────────────────────────

export interface Identity {
	agentId: number;
	chain: string;
	address: string;
	displayName: string;
	dataDir: string;
}

// ──────────────────────────────────────────────────────────────
// Contacts (GET /api/contacts → Contact[])
// ──────────────────────────────────────────────────────────────

export type ConnectionStatus = "connecting" | "active" | "idle" | "stale" | "revoked";

export interface ContactPermissionEntry {
	version: string;
	updatedAt: string;
	grants: unknown[];
}

export interface Contact {
	connectionId: string;
	peerAgentId: number;
	peerChain: string;
	peerOwnerAddress: string;
	peerDisplayName: string;
	peerAgentAddress: string;
	permissions: {
		grantedByMe: ContactPermissionEntry;
		grantedByPeer: ContactPermissionEntry;
	};
	establishedAt: string;
	lastContactAt: string;
	status: ConnectionStatus;
	expiresAt?: string;
}

// ──────────────────────────────────────────────────────────────
// Conversations (GET /api/conversations → ConversationLog[])
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// Pending requests (GET /api/pending → TapPendingRequest[])
// ──────────────────────────────────────────────────────────────

export interface PendingTransferDetails {
	type: "transfer";
	peerName: string;
	peerChain: string;
	amount: string;
	currency: string;
	chain: string;
	memo?: string;
	[key: string]: unknown;
}

export interface PendingSchedulingDetails {
	type: "scheduling";
	peerName: string;
	peerChain: string;
	schedulingId: string;
	title: string;
	duration: number;
	slots: Array<{ start: string; end: string }>;
	originTimezone: string;
	note?: string;
	activeGrantSummary: string[];
	ledgerPath: string;
}

export type PendingRequestDetails = PendingTransferDetails | PendingSchedulingDetails;

export interface PendingItem {
	requestId: string;
	method: string;
	peerAgentId: number;
	direction: string;
	kind: string;
	status: string;
	correlationId?: string;
	details?: PendingRequestDetails;
}

// ──────────────────────────────────────────────────────────────
// SSE event union (mirrors core's TapEvent)
// ──────────────────────────────────────────────────────────────

export interface BaseEvent {
	id: string;
	occurredAt: string;
	identityAgentId: number;
}

export interface PeerRef {
	connectionId: string;
	peerAgentId: number;
	peerName: string;
	peerChain: string;
}

export type ActionKind = "transfer" | "scheduling" | "grant";

export interface MessageReceivedEvent extends BaseEvent {
	type: "message.received";
	conversationId: string;
	peer: PeerRef;
	messageId: string;
	text: string;
	scope: string;
}

export interface MessageSentEvent extends BaseEvent {
	type: "message.sent";
	conversationId: string;
	peer: PeerRef;
	messageId: string;
	text: string;
	scope: string;
}

export interface ActionRequestedEvent extends BaseEvent {
	type: "action.requested";
	conversationId: string;
	peer: PeerRef;
	requestId: string;
	kind: ActionKind;
	payload: Record<string, unknown>;
	direction: "inbound" | "outbound";
}

export interface ActionCompletedEvent extends BaseEvent {
	type: "action.completed";
	conversationId: string;
	requestId: string;
	kind: ActionKind;
	result: Record<string, unknown>;
	txHash?: string;
	completedAt: string;
}

export interface ActionFailedEvent extends BaseEvent {
	type: "action.failed";
	conversationId: string;
	requestId: string;
	kind: ActionKind;
	error: string;
}

export interface ActionPendingEvent extends BaseEvent {
	type: "action.pending";
	conversationId: string;
	requestId: string;
	kind: ActionKind;
	payload: Record<string, unknown>;
	awaitingDecision: true;
}

export interface PendingResolvedEvent extends BaseEvent {
	type: "pending.resolved";
	requestId: string;
	decision: "approved" | "denied";
	decidedBy: "operator" | "auto-grant";
}

export interface ConnectionRequestedEvent extends BaseEvent {
	type: "connection.requested";
	requestId: string;
	peerAgentId: number;
	peerChain: string;
	direction: "inbound" | "outbound";
}

export interface ConnectionEstablishedEvent extends BaseEvent {
	type: "connection.established";
	connectionId: string;
	peer: PeerRef;
}

export interface ConnectionFailedEvent extends BaseEvent {
	type: "connection.failed";
	requestId: string;
	error: string;
}

export interface ContactUpdatedEvent extends BaseEvent {
	type: "contact.updated";
	connectionId: string;
	status: string;
	fields: Record<string, unknown>;
}

export interface DaemonStatusEvent extends BaseEvent {
	type: "daemon.status";
	transportConnected: boolean;
	lastSyncAt?: string;
}

export type TapEvent =
	| MessageReceivedEvent
	| MessageSentEvent
	| ActionRequestedEvent
	| ActionCompletedEvent
	| ActionFailedEvent
	| ActionPendingEvent
	| PendingResolvedEvent
	| ConnectionRequestedEvent
	| ConnectionEstablishedEvent
	| ConnectionFailedEvent
	| ContactUpdatedEvent
	| DaemonStatusEvent;

export type TapEventType = TapEvent["type"];
