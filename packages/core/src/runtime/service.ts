import {
	PermissionError,
	ValidationError,
	caip2ToChainId,
	generateConnectionId,
	generateNonce,
	nowISO,
} from "../common/index.js";
import type { TrustedAgentsConfig } from "../config/types.js";
import {
	buildConnectionRequest,
	buildConnectionResult,
	buildPermissionsUpdate,
	handleConnectionRequest,
	parseInviteUrl,
	verifyInvite,
} from "../connection/index.js";
import type { ResolvedAgent } from "../identity/types.js";
import {
	TAP_GRANTS_VERSION,
	createEmptyPermissionState,
	createGrantSet,
} from "../permissions/index.js";
import type { PermissionGrantSet } from "../permissions/types.js";
import {
	ACTION_REQUEST,
	ACTION_RESULT,
	CONNECTION_REQUEST,
	CONNECTION_RESULT,
	MESSAGE_SEND,
	PERMISSIONS_UPDATE,
} from "../protocol/methods.js";
import type {
	AgentIdentifier,
	ConnectionPermissionIntent,
	ConnectionRequestParams,
	ConnectionResultParams,
	PermissionsUpdateParams,
} from "../protocol/types.js";
import type { ProtocolMessage } from "../transport/interface.js";
import type {
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "../transport/interface.js";
import type { Contact } from "../trust/types.js";
import {
	type PermissionGrantRequestAction,
	type TransferActionRequest,
	type TransferActionResponse,
	buildPermissionGrantRequestText,
	buildTransferRequestText,
	buildTransferResponseText,
	parsePermissionGrantRequest,
	parseTransferActionRequest,
	parseTransferActionResponse,
} from "./actions.js";
import type { TapRuntimeContext } from "./default-context.js";
import {
	findActiveGrantsByScope,
	replaceGrantedByMe,
	replaceGrantedByPeer,
	summarizeGrant,
	summarizeGrantSet,
} from "./grants.js";
import {
	DEFAULT_MESSAGE_SCOPE,
	appendConversationLog,
	buildOutgoingActionRequest,
	buildOutgoingActionResult,
	buildOutgoingMessageRequest,
	findContactForPeer,
	findUniqueContactForAgentId,
} from "./message-conversations.js";
import {
	type PermissionLedgerEntry,
	appendPermissionLedgerEntry,
	getPermissionLedgerPath,
} from "./permission-ledger.js";
import {
	type TransportOwnerInfo,
	TransportOwnerLock,
	TransportOwnershipError,
} from "./transport-owner-lock.js";

export interface TapConnectionApprovalContext {
	requestId: string;
	peer: ResolvedAgent;
	intent: ConnectionPermissionIntent | undefined;
	alreadyActive: boolean;
}

export interface TapTransferApprovalContext {
	requestId: string;
	contact: Contact;
	request: TransferActionRequest;
	activeTransferGrants: ReturnType<typeof findActiveGrantsByScope>;
	ledgerPath: string;
}

export interface TapPendingConnectionDetails {
	type: "connection";
	peerName: string;
	peerChain: string;
	capabilities: string[];
	alreadyActive: boolean;
	requestedGrantSummary: string[];
	offeredGrantSummary: string[];
}

export interface TapPendingTransferDetails {
	type: "transfer";
	peerName: string;
	peerChain: string;
	asset: TransferActionRequest["asset"];
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
	activeGrantSummary: string[];
	ledgerPath: string;
}

export type TapPendingRequestDetails = TapPendingConnectionDetails | TapPendingTransferDetails;

export interface TapPendingRequest {
	requestId: string;
	method: string;
	peerAgentId: number;
	direction: string;
	kind: string;
	status: string;
	correlationId?: string;
	details?: TapPendingRequestDetails;
}

export interface TapServiceHooks {
	approveConnection?: (context: TapConnectionApprovalContext) => Promise<boolean | null>;
	approveTransfer?: (context: TapTransferApprovalContext) => Promise<boolean | null>;
	executeTransfer?: (
		config: TrustedAgentsConfig,
		request: TransferActionRequest,
	) => Promise<{ txHash: `0x${string}` }>;
	appendLedgerEntry?: (dataDir: string, entry: PermissionLedgerEntry) => Promise<string>;
	log?: (level: "info" | "warn" | "error", message: string) => void;
	emitEvent?: (payload: Record<string, unknown>) => void;
}

export interface TapServiceOptions {
	autoApproveConnections?: boolean;
	autoApproveActions?: boolean;
	ownerLabel?: string;
	hooks?: TapServiceHooks;
}

export interface TapServiceStatus {
	running: boolean;
	lock: TransportOwnerInfo | null;
	lastSyncAt?: string;
	pendingRequests: TapPendingRequest[];
}

export interface TapSyncReport {
	synced: true;
	processed: number;
	pendingRequests: TapServiceStatus["pendingRequests"];
}

export interface TapConnectResult {
	connectionId: string;
	peerName: string;
	peerAgentId: number;
	status: "active" | "pending";
	receipt?: TransportReceipt;
	requestedGrants: PermissionGrantSet["grants"];
	offeredGrants: PermissionGrantSet["grants"];
}

export interface TapSendMessageResult {
	receipt: TransportReceipt;
	peerName: string;
	peerAgentId: number;
	scope: string;
}

export interface TapPublishGrantSetResult {
	receipt: TransportReceipt;
	peerName: string;
	peerAgentId: number;
	grantCount: number;
}

export interface TapRequestGrantSetResult {
	receipt: TransportReceipt;
	actionId: string;
	peerName: string;
	peerAgentId: number;
	grantCount: number;
}

export interface TapRequestFundsInput {
	peer: string;
	asset: "native" | "usdc";
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
}

export interface TapRequestFundsResult {
	receipt: TransportReceipt;
	actionId: string;
	peerName: string;
	peerAgentId: number;
	asset: "native" | "usdc";
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	asyncResult?: TransferActionResponse;
}

export class TapMessagingService {
	private readonly context: TapRuntimeContext;
	private readonly hooks: TapServiceHooks;
	private readonly autoApproveConnections: boolean;
	private readonly autoApproveActions: boolean;
	private readonly ownerLock: TransportOwnerLock;
	private readonly pendingTasks = new Set<Promise<void>>();
	private readonly inFlightKeys = new Set<string>();
	private readonly decisionOverrides = {
		connections: new Map<string, boolean>(),
		transfers: new Map<string, boolean>(),
	};
	private readonly waiters = new Map<string, (value: TransferActionResponse) => void>();
	private readonly handlers: TransportHandlers;
	private running = false;
	private lastSyncAt: string | undefined;

	constructor(context: TapRuntimeContext, options: TapServiceOptions = {}) {
		this.context = context;
		this.hooks = options.hooks ?? {};
		this.autoApproveConnections = options.autoApproveConnections ?? false;
		this.autoApproveActions = options.autoApproveActions ?? false;
		this.ownerLock = new TransportOwnerLock(
			context.config.dataDir,
			options.ownerLabel ?? `tap:${process.pid}`,
		);
		this.handlers = {
			onRequest: async (envelope) => await this.onRequest(envelope),
			onResult: async (envelope) => await this.onResult(envelope),
		};
	}

	get transport(): TransportProvider {
		return this.context.transport;
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		await this.ownerLock.acquire();
		try {
			this.context.transport.setHandlers(this.handlers);
			await this.context.transport.start?.();
			this.running = true;
			await this.runReconcile();
		} catch (error) {
			this.running = false;
			await this.ownerLock.release().catch(() => {});
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		try {
			await this.drain();
			await this.context.transport.stop?.();
		} finally {
			this.running = false;
			await this.ownerLock.release().catch(() => {});
		}
	}

	async syncOnce(): Promise<TapSyncReport> {
		const processed = await this.withTransportSession(async () => await this.runReconcile());
		return await this.buildSyncReport(processed);
	}

	async getStatus(): Promise<TapServiceStatus> {
		const pendingRequests = await this.listPendingRequests();
		return {
			running: this.running,
			lock: await this.ownerLock.inspect(),
			lastSyncAt: this.lastSyncAt,
			pendingRequests,
		};
	}

	async listPendingRequests(): Promise<TapServiceStatus["pendingRequests"]> {
		const pending = await this.context.requestJournal.listPending();
		return pending.map((entry) => ({
			requestId: entry.requestId,
			method: entry.method,
			peerAgentId: entry.peerAgentId,
			direction: entry.direction,
			kind: entry.kind,
			status: entry.status,
			correlationId: entry.correlationId,
			details: parsePendingRequestDetails(entry.metadata),
		}));
	}

	async resolvePending(requestId: string, approve: boolean): Promise<TapSyncReport> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		if (!entry || entry.direction !== "inbound" || entry.kind !== "request") {
			throw new ValidationError(`Pending inbound request not found: ${requestId}`);
		}

		const decisionStore =
			entry.method === CONNECTION_REQUEST
				? this.decisionOverrides.connections
				: entry.method === ACTION_REQUEST
					? this.decisionOverrides.transfers
					: null;

		if (!decisionStore) {
			throw new ValidationError(`Request ${requestId} cannot be resolved manually`);
		}

		decisionStore.set(requestId, approve);
		try {
			return await this.syncOnce();
		} finally {
			decisionStore.delete(requestId);
		}
	}

	async connect(params: {
		inviteUrl: string;
		requestedGrants?: PermissionGrantSet;
		offeredGrants?: PermissionGrantSet;
	}): Promise<TapConnectResult> {
		return await this.withTransportSession(async () => {
			const { config, resolver, trustStore, requestJournal, transport } = this.context;
			const chainId = caip2ToChainId(config.chain);
			if (chainId === null) {
				throw new ValidationError(`Invalid local chain format: ${config.chain}`);
			}

			const invite = parseInviteUrl(params.inviteUrl);
			const peerAgent = await resolver.resolve(invite.agentId, invite.chain);
			const verification = await verifyInvite(invite, {
				expectedSignerAddress: peerAgent.agentAddress,
			});
			if (!verification.valid) {
				throw new ValidationError(verification.error ?? "Invite verification failed");
			}

			const existing = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
			if (existing?.status === "active") {
				return {
					connectionId: existing.connectionId,
					peerName: existing.peerDisplayName,
					peerAgentId: existing.peerAgentId,
					status: "active",
					requestedGrants: params.requestedGrants?.grants ?? [],
					offeredGrants: params.offeredGrants?.grants ?? [],
				};
			}

			const from: AgentIdentifier = { agentId: config.agentId, chain: config.chain };
			const to: AgentIdentifier = { agentId: invite.agentId, chain: invite.chain };
			const requestedAt = nowISO();
			const connectionId = existing?.connectionId ?? generateConnectionId();
			const requestNonce = generateNonce();
			const requestParams: ConnectionRequestParams = {
				from,
				to,
				connectionId,
				...(params.requestedGrants || params.offeredGrants
					? {
							permissionIntent: {
								...(params.requestedGrants
									? { requestedGrants: params.requestedGrants.grants }
									: {}),
								...(params.offeredGrants ? { offeredGrants: params.offeredGrants.grants } : {}),
							},
						}
					: {}),
				nonce: requestNonce,
				protocolVersion: "1.0",
				timestamp: requestedAt,
			};

			const rpcRequest = buildConnectionRequest(requestParams);
			const requestId = String(rpcRequest.id);
			const receipt = await transport.send(peerAgent.agentId, rpcRequest, {
				peerAddress: peerAgent.xmtpEndpoint ?? peerAgent.agentAddress,
			});

			const nextContact = {
				connectionId,
				peerAgentId: peerAgent.agentId,
				peerChain: peerAgent.chain,
				peerOwnerAddress: peerAgent.ownerAddress,
				peerDisplayName: peerAgent.registrationFile.name,
				peerAgentAddress: peerAgent.agentAddress,
				permissions: existing?.permissions ?? createEmptyPermissionState(requestedAt),
				establishedAt: existing?.establishedAt ?? requestedAt,
				lastContactAt: requestedAt,
				status: "pending" as const,
				pending: {
					direction: "outbound" as const,
					requestId,
					requestNonce,
					requestedAt,
					inviteNonce: invite.nonce,
					initialRequestedGrants: params.requestedGrants,
					initialOfferedGrants: params.offeredGrants,
				},
			};

			if (existing) {
				await trustStore.updateContact(existing.connectionId, nextContact);
			} else {
				await trustStore.addContact(nextContact);
			}

			await requestJournal.putOutbound({
				requestId,
				requestKey: `outbound:${rpcRequest.method}:${requestId}`,
				direction: "outbound",
				kind: "request",
				method: rpcRequest.method,
				peerAgentId: peerAgent.agentId,
				status: "acked",
			});

			return {
				connectionId,
				peerName: peerAgent.registrationFile.name,
				peerAgentId: peerAgent.agentId,
				status: "pending",
				receipt,
				requestedGrants: params.requestedGrants?.grants ?? [],
				offeredGrants: params.offeredGrants?.grants ?? [],
			};
		});
	}

	async sendMessage(
		peer: string,
		text: string,
		scope = DEFAULT_MESSAGE_SCOPE,
	): Promise<TapSendMessageResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(peer);
			const request = buildOutgoingMessageRequest(contact, text, scope);
			const timestamp = nowISO();
			const receipt = await this.context.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
			});

			await appendConversationLog(
				this.context.conversationLogger,
				contact,
				request,
				"outgoing",
				timestamp,
			);
			await this.context.trustStore.touchContact(contact.connectionId);

			return {
				receipt,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				scope,
			};
		});
	}

	async publishGrantSet(
		peer: string,
		grantSet: PermissionGrantSet,
		note?: string,
	): Promise<TapPublishGrantSetResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireContact(peer);
			const updatedPermissions = replaceGrantedByMe(contact.permissions, grantSet);
			await this.context.trustStore.updateContact(contact.connectionId, {
				permissions: updatedPermissions,
			});

			const request = buildPermissionsUpdate({
				grantSet,
				grantor: { agentId: this.context.config.agentId, chain: this.context.config.chain },
				grantee: { agentId: contact.peerAgentId, chain: contact.peerChain },
				note,
				timestamp: nowISO(),
			});
			const receipt = await this.context.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
			});

			await this.appendLedger({
				peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
				direction: "granted-by-me",
				event: "grant-published",
				note,
			});

			return {
				receipt,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				grantCount: grantSet.grants.length,
			};
		});
	}

	async requestGrantSet(
		peer: string,
		grantSet: PermissionGrantSet,
		note?: string,
	): Promise<TapRequestGrantSetResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(peer);
			const action: PermissionGrantRequestAction = {
				type: "permissions/request-grants",
				actionId: generateNonce(),
				grants: grantSet.grants,
				note,
			};
			const request = buildOutgoingActionRequest(
				contact,
				buildPermissionGrantRequestText(action),
				action,
				"permissions/request-grants",
			);

			const timestamp = nowISO();
			const receipt = await this.context.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
			});
			await appendConversationLog(
				this.context.conversationLogger,
				contact,
				request,
				"outgoing",
				timestamp,
			);
			await this.context.trustStore.touchContact(contact.connectionId);

			await this.appendLedger({
				peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
				direction: "local",
				event: "grant-request-sent",
				action_id: action.actionId,
				note,
			});

			return {
				receipt,
				actionId: action.actionId,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				grantCount: grantSet.grants.length,
			};
		});
	}

	async requestFunds(input: TapRequestFundsInput): Promise<TapRequestFundsResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(input.peer);
			const requestPayload = {
				type: "transfer/request" as const,
				actionId: generateNonce(),
				asset: input.asset,
				amount: input.amount,
				chain: input.chain,
				toAddress: input.toAddress,
				note: input.note,
			};
			const request = buildOutgoingActionRequest(
				contact,
				buildTransferRequestText(requestPayload),
				requestPayload,
				"transfer/request",
			);
			const requestId = String(request.id);
			const timestamp = nowISO();

			await this.appendLedger({
				timestamp,
				peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
				direction: "local",
				event: "transfer-request-sent",
				scope: "transfer/request",
				asset: input.asset,
				amount: input.amount,
				action_id: requestPayload.actionId,
				note: input.note,
			});

			const receipt = await this.context.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
			});
			await appendConversationLog(
				this.context.conversationLogger,
				contact,
				request,
				"outgoing",
				timestamp,
			);
			await this.context.trustStore.touchContact(contact.connectionId);
			await this.context.requestJournal.putOutbound({
				requestId,
				requestKey: `outbound:${request.method}:${requestId}`,
				direction: "outbound",
				kind: "request",
				method: request.method,
				peerAgentId: contact.peerAgentId,
				status: "acked",
			});

			const asyncResult = await this.waitForActionResult(requestId, requestPayload.actionId, 5_000);
			if (!asyncResult) {
				await this.runReconcile();
			}
			await this.drain();

			if (asyncResult?.status === "rejected") {
				throw new PermissionError(asyncResult.error ?? "Action rejected by agent");
			}
			if (asyncResult?.status === "failed") {
				throw new Error(asyncResult.error ?? "Transfer request failed");
			}

			return {
				receipt,
				actionId: requestPayload.actionId,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				asset: input.asset,
				amount: input.amount,
				chain: input.chain,
				toAddress: input.toAddress,
				asyncResult: asyncResult ?? undefined,
			};
		});
	}

	private async withTransportSession<T>(task: () => Promise<T>): Promise<T> {
		if (this.running) {
			return await task();
		}

		await this.ownerLock.acquire();
		try {
			this.context.transport.setHandlers(this.handlers);
			await this.context.transport.start?.();
			try {
				return await task();
			} finally {
				await this.drain();
				await this.context.transport.stop?.();
			}
		} finally {
			await this.ownerLock.release().catch(() => {});
		}
	}

	private async runReconcile(): Promise<number> {
		const reconciled = (await this.context.transport.reconcile?.()) ?? {
			synced: true,
			processed: 0,
		};
		await this.drain();
		this.lastSyncAt = nowISO();
		return reconciled.processed;
	}

	private async buildSyncReport(processed: number): Promise<TapSyncReport> {
		return {
			synced: true,
			processed,
			pendingRequests: await this.listPendingRequests(),
		};
	}

	private emitEvent(payload: Record<string, unknown>): void {
		this.hooks.emitEvent?.({
			timestamp: nowISO(),
			...payload,
		});
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		this.hooks.log?.(level, message);
	}

	private appendLedger(entry: PermissionLedgerEntry): Promise<string> {
		if (this.hooks.appendLedgerEntry) {
			return this.hooks.appendLedgerEntry(this.context.config.dataDir, entry);
		}
		return appendPermissionLedgerEntry(this.context.config.dataDir, entry);
	}

	private enqueue(key: string, task: () => Promise<void>): void {
		if (this.inFlightKeys.has(key)) {
			return;
		}

		this.inFlightKeys.add(key);
		const promise = task()
			.catch((error: unknown) => {
				this.log("error", error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				this.inFlightKeys.delete(key);
				this.pendingTasks.delete(promise);
			});
		this.pendingTasks.add(promise);
	}

	private async drain(): Promise<void> {
		await Promise.allSettled([...this.pendingTasks]);
	}

	private async waitForActionResult(
		requestId: string,
		actionId: string,
		timeoutMs: number,
	): Promise<TransferActionResponse | null> {
		const immediate = await this.context.requestJournal.getByRequestId(requestId);
		if (immediate?.status === "completed") {
			return null;
		}

		return await new Promise<TransferActionResponse | null>((resolve) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(requestId);
				resolve(null);
			}, timeoutMs);

			this.waiters.set(requestId, (value) => {
				if (value.actionId !== actionId) {
					return;
				}
				clearTimeout(timeout);
				this.waiters.delete(requestId);
				resolve(value);
			});
		});
	}

	private async onRequest(envelope: {
		from: number;
		senderInboxId: string;
		message: ProtocolMessage;
	}): Promise<{ status: "received" | "duplicate" | "queued" }> {
		const requestKey = buildRequestKey(envelope.senderInboxId, envelope.message);
		const claimed = await this.context.requestJournal.claimInbound({
			requestId: String(envelope.message.id),
			requestKey,
			direction: "inbound",
			kind: "request",
			method: envelope.message.method,
			peerAgentId: envelope.from,
		});

		if (claimed.duplicate && claimed.entry.status === "completed") {
			this.emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: "duplicate",
			});
			return { status: "duplicate" };
		}

		if (envelope.message.method === CONNECTION_REQUEST) {
			this.enqueue(requestKey, async () => {
				await this.processConnectionRequest(envelope, String(envelope.message.id));
			});
			const status = claimed.duplicate ? "duplicate" : "queued";
			this.emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: status,
			});
			return { status };
		}

		const contact = await findContactForMessage(this.context, envelope.from, envelope.message);
		if (!contact) {
			throw new ValidationError(`No contact found for agent ${envelope.from}`);
		}

		if (envelope.message.method === PERMISSIONS_UPDATE) {
			await this.handlePermissionsUpdate(contact, envelope.message);
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
			const status = claimed.duplicate ? "duplicate" : "received";
			this.emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: status,
			});
			return { status };
		}

		await appendConversationLog(
			this.context.conversationLogger,
			contact,
			envelope.message,
			"incoming",
		);
		await this.context.trustStore.touchContact(contact.connectionId);

		if (envelope.message.method === MESSAGE_SEND) {
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
			const status = claimed.duplicate ? "duplicate" : "received";
			this.emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: status,
			});
			return { status };
		}

		if (envelope.message.method !== ACTION_REQUEST) {
			throw new ValidationError(`Unsupported request method: ${envelope.message.method}`);
		}

		const permissionRequest = parsePermissionGrantRequest(envelope.message);
		if (permissionRequest) {
			await this.handlePermissionGrantRequest(contact, permissionRequest);
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
			const status = claimed.duplicate ? "duplicate" : "received";
			this.emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: status,
			});
			return { status };
		}

		const transferRequest = parseTransferActionRequest(envelope.message);
		if (!transferRequest) {
			throw new ValidationError("Unsupported action request payload");
		}
		await this.context.requestJournal.updateMetadata(
			String(envelope.message.id),
			serializePendingRequestDetails(
				buildPendingTransferDetails(contact, transferRequest, this.context.config.dataDir),
			),
		);

		this.enqueue(requestKey, async () => {
			await this.processTransferRequest(
				contact,
				String(envelope.message.id),
				envelope.message,
				transferRequest,
			);
		});
		const status = claimed.duplicate ? "duplicate" : "queued";
		this.emitEvent({
			direction: "incoming",
			from: envelope.from,
			method: envelope.message.method,
			id: envelope.message.id,
			receipt_status: status,
		});
		return { status };
	}

	private async onResult(envelope: {
		from: number;
		senderInboxId: string;
		message: ProtocolMessage;
	}): Promise<{ status: "received" | "duplicate" }> {
		const requestKey = buildRequestKey(envelope.senderInboxId, envelope.message);
		const claimed = await this.context.requestJournal.claimInbound({
			requestId: String(envelope.message.id),
			requestKey,
			direction: "inbound",
			kind: "result",
			method: envelope.message.method,
			peerAgentId: envelope.from,
		});

		if (claimed.duplicate && claimed.entry.status === "completed") {
			this.emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: "duplicate",
			});
			return { status: "duplicate" };
		}

		if (envelope.message.method === CONNECTION_RESULT) {
			await this.handleConnectionResult(envelope.message);
		} else if (envelope.message.method === ACTION_RESULT) {
			await this.handleActionResult(envelope.from, envelope.message);
		} else {
			throw new ValidationError(`Unsupported result method: ${envelope.message.method}`);
		}

		await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
		const status = claimed.duplicate ? "duplicate" : "received";
		this.emitEvent({
			direction: "incoming",
			from: envelope.from,
			method: envelope.message.method,
			id: envelope.message.id,
			receipt_status: status,
		});
		return { status };
	}

	private async processConnectionRequest(
		envelope: {
			from: number;
			senderInboxId: string;
			message: ProtocolMessage;
		},
		requestId: string,
	): Promise<void> {
		const params = parseConnectionRequest(envelope.message);
		const peer = await this.context.resolver.resolveWithCache(
			params.from.agentId,
			params.from.chain,
		);
		const existing = await this.context.trustStore.findByAgentId(peer.agentId, peer.chain);
		await this.context.requestJournal.updateMetadata(
			requestId,
			serializePendingRequestDetails(
				buildPendingConnectionDetails(peer, params.permissionIntent, existing?.status === "active"),
			),
		);

		if (existing?.status !== "active") {
			const pendingContact = {
				connectionId: existing?.connectionId ?? params.connectionId,
				peerAgentId: peer.agentId,
				peerChain: peer.chain,
				peerOwnerAddress: peer.ownerAddress,
				peerDisplayName: peer.registrationFile.name,
				peerAgentAddress: peer.agentAddress,
				permissions: existing?.permissions ?? createEmptyPermissionState(params.timestamp),
				establishedAt: existing?.establishedAt ?? params.timestamp,
				lastContactAt: params.timestamp,
				status: "pending" as const,
				pending: {
					direction: "inbound" as const,
					requestId,
					requestNonce: params.nonce,
					requestedAt: params.timestamp,
				},
			};

			if (existing) {
				await this.context.trustStore.updateContact(existing.connectionId, pendingContact);
			} else {
				await this.context.trustStore.addContact(pendingContact);
			}
		}

		const decision = await this.decideConnection(
			requestId,
			peer,
			params.permissionIntent,
			existing?.status === "active",
		);
		if (decision === null) {
			this.log(
				"info",
				`Queued connection request from ${peer.registrationFile.name} (#${peer.agentId}); resolve it later with TAP sync or the host approval flow`,
			);
			return;
		}

		const outcome = await handleConnectionRequest({
			message: envelope.message,
			resolver: this.context.resolver,
			trustStore: this.context.trustStore,
			ownAgent: { agentId: this.context.config.agentId, chain: this.context.config.chain },
			approve: async () => decision,
		});
		const resultMessage = buildConnectionResult(outcome.result);
		const peerAddress = outcome.peer.xmtpEndpoint ?? outcome.peer.agentAddress;
		await this.context.transport.send(outcome.peer.agentId, resultMessage, {
			peerAddress,
			timeout: 5_000,
		});
		await this.context.requestJournal.putOutbound({
			requestId: String(resultMessage.id),
			requestKey: `outbound:${resultMessage.method}:${String(resultMessage.id)}`,
			direction: "outbound",
			kind: "result",
			method: resultMessage.method,
			peerAgentId: outcome.peer.agentId,
			correlationId: outcome.result.requestId,
			status: "completed",
		});
		await this.context.requestJournal.updateStatus(requestId, "completed");

		if (outcome.result.status === "rejected") {
			const pendingContact = await this.context.trustStore.findByAgentId(
				outcome.peer.agentId,
				outcome.peer.chain,
			);
			if (pendingContact?.status === "pending") {
				await this.context.trustStore.removeContact(pendingContact.connectionId);
			}
		}

		this.log(
			"info",
			`${outcome.result.status === "accepted" ? "Accepted" : "Rejected"} connection request from ${outcome.peer.registrationFile.name} (#${outcome.peer.agentId})`,
		);
	}

	private async handlePermissionsUpdate(contact: Contact, message: ProtocolMessage): Promise<void> {
		const update = parsePermissionsUpdate(message);
		await this.context.trustStore.updateContact(contact.connectionId, {
			permissions: replaceGrantedByPeer(contact.permissions, update.grantSet),
		});
		await this.appendLedger({
			peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
			direction: "granted-by-peer",
			event: "grant-received",
			note: update.note,
		});
		await this.context.trustStore.touchContact(contact.connectionId);

		this.log("info", `Grant update from ${contact.peerDisplayName} (#${contact.peerAgentId})`);
		for (const line of summarizeGrantSet(update.grantSet)) {
			this.log("info", `  - ${line}`);
		}
		if (update.note) {
			this.log("info", `Note: ${update.note}`);
		}
	}

	private async handlePermissionGrantRequest(
		contact: Contact,
		request: PermissionGrantRequestAction,
	): Promise<void> {
		this.log("info", `Grant request from ${contact.peerDisplayName} (#${contact.peerAgentId})`);
		for (const line of summarizeGrantSet(createGrantSet(request.grants))) {
			this.log("info", `  - ${line}`);
		}
		if (request.note) {
			this.log("info", `Note: ${request.note}`);
		}

		await this.appendLedger({
			peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
			direction: "local",
			event: "grant-request-received",
			action_id: request.actionId,
			note: request.note,
		});
	}

	private async processTransferRequest(
		contact: Contact,
		requestId: string,
		message: ProtocolMessage,
		request: TransferActionRequest,
	): Promise<void> {
		const approved = await this.decideTransfer(requestId, contact, request);
		if (approved === null) {
			this.log(
				"info",
				`Queued action request ${request.actionId} from ${contact.peerDisplayName}; resolve it later with TAP sync or the host approval flow`,
			);
			return;
		}

		let response: TransferActionResponse;
		if (!approved) {
			response = {
				type: "transfer/response",
				actionId: request.actionId,
				asset: request.asset,
				amount: request.amount,
				chain: request.chain,
				toAddress: request.toAddress,
				status: "rejected",
				error: "Action rejected by agent",
			};
			await this.appendLedger({
				peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
				direction: "granted-by-me",
				event: "transfer-rejected",
				scope: "transfer/request",
				asset: request.asset,
				amount: request.amount,
				action_id: request.actionId,
				decision: "rejected",
				rationale: "Rejected at runtime by agent decision",
			});
		} else if (!this.hooks.executeTransfer) {
			response = {
				type: "transfer/response",
				actionId: request.actionId,
				asset: request.asset,
				amount: request.amount,
				chain: request.chain,
				toAddress: request.toAddress,
				status: "failed",
				error: "No transfer executor configured for this TAP host",
			};
		} else {
			try {
				const transfer = await this.hooks.executeTransfer(this.context.config, request);
				response = {
					type: "transfer/response",
					actionId: request.actionId,
					asset: request.asset,
					amount: request.amount,
					chain: request.chain,
					toAddress: request.toAddress,
					status: "completed",
					txHash: transfer.txHash,
				};
				await this.appendLedger({
					peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
					direction: "granted-by-me",
					event: "transfer-completed",
					scope: "transfer/request",
					asset: request.asset,
					amount: request.amount,
					action_id: request.actionId,
					tx_hash: transfer.txHash,
					decision: "approved",
					rationale: "Approved at runtime by agent decision",
				});
			} catch (error: unknown) {
				response = {
					type: "transfer/response",
					actionId: request.actionId,
					asset: request.asset,
					amount: request.amount,
					chain: request.chain,
					toAddress: request.toAddress,
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
				await this.appendLedger({
					peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
					direction: "granted-by-me",
					event: "transfer-failed",
					scope: "transfer/request",
					asset: request.asset,
					amount: request.amount,
					action_id: request.actionId,
					decision: "approved",
					rationale: response.error,
				});
			}
		}

		await this.sendActionResult(contact, String(message.id), response);
		await this.context.requestJournal.updateStatus(requestId, "completed");
	}

	private async handleConnectionResult(message: ProtocolMessage): Promise<void> {
		const result = parseConnectionResult(message);
		const contact = await this.context.trustStore.findByAgentId(
			result.from.agentId,
			result.from.chain,
		);
		if (contact) {
			if (result.status === "accepted") {
				if (!result.connectionId) {
					throw new ValidationError("Accepted connection result missing connectionId");
				}
				if (contact.connectionId !== result.connectionId) {
					throw new ValidationError("Connection result returned an unexpected connectionId");
				}
				const nextPermissions = contact.pending?.initialOfferedGrants
					? {
							...contact.permissions,
							grantedByMe: contact.pending.initialOfferedGrants,
						}
					: contact.permissions;
				await this.context.trustStore.updateContact(contact.connectionId, {
					permissions: nextPermissions,
					status: "active",
					pending: undefined,
					lastContactAt: result.timestamp,
				});
				this.log(
					"info",
					`Connection accepted by ${contact.peerDisplayName} (#${contact.peerAgentId})`,
				);
			} else {
				await this.context.trustStore.removeContact(contact.connectionId);
				this.log(
					"info",
					`Connection rejected by ${contact.peerDisplayName} (#${contact.peerAgentId})`,
				);
			}
		}

		await this.context.requestJournal.updateStatus(result.requestId, "completed");
	}

	private async handleActionResult(from: number, message: ProtocolMessage): Promise<void> {
		const contact = await findContactForMessage(this.context, from, message);
		if (contact) {
			await appendConversationLog(this.context.conversationLogger, contact, message, "incoming");
			await this.context.trustStore.touchContact(contact.connectionId);
		}

		const response = parseTransferActionResponse(message);
		if (!response) {
			return;
		}

		if (contact) {
			await this.appendLedger({
				peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
				direction: "local",
				event: `transfer-${response.status}`,
				scope: "transfer/request",
				asset: response.asset,
				amount: response.amount,
				action_id: response.actionId,
				tx_hash: response.txHash,
				decision: response.status,
				rationale: response.error,
			});
		}
		if (response.requestId) {
			await this.context.requestJournal.updateStatus(response.requestId, "completed");
			this.waiters.get(response.requestId)?.(response);
		}
		if (contact) {
			this.log(
				"info",
				`Received transfer ${response.status} result from ${contact.peerDisplayName} (#${contact.peerAgentId})`,
			);
		}
	}

	private async decideConnection(
		requestId: string,
		peer: ResolvedAgent,
		intent: ConnectionPermissionIntent | undefined,
		alreadyActive: boolean,
	): Promise<boolean | null> {
		if (alreadyActive) {
			return true;
		}

		const override = this.decisionOverrides.connections.get(requestId);
		if (override !== undefined) {
			return override;
		}

		if (this.autoApproveConnections) {
			this.log(
				"info",
				`Auto-accepting connection from ${peer.registrationFile.name} (#${peer.agentId})`,
			);
			return true;
		}

		return (
			(await this.hooks.approveConnection?.({
				requestId,
				peer,
				intent,
				alreadyActive,
			})) ?? null
		);
	}

	private async decideTransfer(
		requestId: string,
		contact: Contact,
		request: TransferActionRequest,
	): Promise<boolean | null> {
		const override = this.decisionOverrides.transfers.get(requestId);
		if (override !== undefined) {
			return override;
		}

		if (this.autoApproveActions) {
			return true;
		}

		const transferGrants = findActiveGrantsByScope(
			contact.permissions.grantedByMe,
			"transfer/request",
		);
		return (
			(await this.hooks.approveTransfer?.({
				requestId,
				contact,
				request,
				activeTransferGrants: transferGrants,
				ledgerPath: getPermissionLedgerPath(this.context.config.dataDir),
			})) ?? null
		);
	}

	private async sendActionResult(
		contact: Contact,
		requestId: string,
		response: TransferActionResponse,
	): Promise<void> {
		const request = buildOutgoingActionResult(
			contact,
			requestId,
			buildTransferResponseText(response),
			response,
			"transfer/request",
			response.status,
		);

		await this.context.transport.send(contact.peerAgentId, request, {
			peerAddress: contact.peerAgentAddress,
			timeout: 5_000,
		});
		await appendConversationLog(this.context.conversationLogger, contact, request, "outgoing");
		await this.context.trustStore.touchContact(contact.connectionId);
		await this.context.requestJournal.putOutbound({
			requestId: String(request.id),
			requestKey: `outbound:${request.method}:${String(request.id)}`,
			direction: "outbound",
			kind: "result",
			method: request.method,
			peerAgentId: contact.peerAgentId,
			correlationId: requestId,
			status: "completed",
		});
	}

	private async requireContact(peer: string): Promise<Contact> {
		const contacts = await this.context.trustStore.getContacts();
		const contact = findContactForPeer(contacts, peer);
		if (!contact) {
			throw new ValidationError(`Peer not found in contacts: ${peer}`);
		}
		return contact;
	}

	private async requireActiveContact(peer: string): Promise<Contact> {
		const contact = await this.requireContact(peer);
		if (contact.status !== "active") {
			throw new ValidationError(`Contact is not active: ${contact.peerDisplayName}`);
		}
		return contact;
	}
}

function buildRequestKey(senderInboxId: string, message: ProtocolMessage): string {
	return `${senderInboxId}:${message.method}:${String(message.id)}`;
}

function parseConnectionRequest(message: ProtocolMessage): ConnectionRequestParams {
	const params = message.params as ConnectionRequestParams | undefined;
	if (
		typeof params?.from?.agentId !== "number" ||
		typeof params.from.chain !== "string" ||
		typeof params.to?.agentId !== "number" ||
		typeof params.to.chain !== "string" ||
		typeof params.connectionId !== "string" ||
		typeof params.nonce !== "string" ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid connection request payload");
	}
	return params;
}

function parseConnectionResult(message: ProtocolMessage): ConnectionResultParams {
	const params = message.params as ConnectionResultParams | undefined;
	if (
		typeof params?.requestId !== "string" ||
		typeof params.requestNonce !== "string" ||
		typeof params.from?.agentId !== "number" ||
		typeof params.from.chain !== "string" ||
		typeof params.to?.agentId !== "number" ||
		typeof params.to.chain !== "string" ||
		(params.status !== "accepted" && params.status !== "rejected") ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid connection result payload");
	}
	return params;
}

function parsePermissionsUpdate(
	message: ProtocolMessage,
): PermissionsUpdateParams & { note?: string } {
	if (typeof message.params !== "object" || message.params === null) {
		throw new ValidationError("Invalid grant publication payload");
	}

	const params = message.params as {
		grantSet?: PermissionsUpdateParams["grantSet"];
		grantor?: PermissionsUpdateParams["grantor"];
		grantee?: PermissionsUpdateParams["grantee"];
		note?: unknown;
		timestamp?: unknown;
	};

	if (
		typeof params.grantSet !== "object" ||
		params.grantSet === null ||
		!Array.isArray(params.grantSet.grants) ||
		typeof params.grantSet.updatedAt !== "string" ||
		params.grantSet.version !== TAP_GRANTS_VERSION ||
		typeof params.grantor?.agentId !== "number" ||
		typeof params.grantor.chain !== "string" ||
		typeof params.grantee?.agentId !== "number" ||
		typeof params.grantee.chain !== "string" ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid grant publication payload");
	}

	return {
		grantSet: params.grantSet,
		grantor: params.grantor,
		grantee: params.grantee,
		note: typeof params.note === "string" && params.note.length > 0 ? params.note : undefined,
		timestamp: params.timestamp,
	};
}

function buildPendingConnectionDetails(
	peer: ResolvedAgent,
	intent: ConnectionPermissionIntent | undefined,
	alreadyActive: boolean,
): TapPendingConnectionDetails {
	return {
		type: "connection",
		peerName: peer.registrationFile.name,
		peerChain: peer.chain,
		capabilities: peer.capabilities,
		alreadyActive,
		requestedGrantSummary: intent?.requestedGrants?.map((grant) => summarizeGrant(grant)) ?? [],
		offeredGrantSummary: intent?.offeredGrants?.map((grant) => summarizeGrant(grant)) ?? [],
	};
}

function buildPendingTransferDetails(
	contact: Contact,
	request: TransferActionRequest,
	dataDir: string,
): TapPendingTransferDetails {
	return {
		type: "transfer",
		peerName: contact.peerDisplayName,
		peerChain: contact.peerChain,
		asset: request.asset,
		amount: request.amount,
		chain: request.chain,
		toAddress: request.toAddress,
		note: request.note,
		activeGrantSummary: findActiveGrantsByScope(
			contact.permissions.grantedByMe,
			"transfer/request",
		).map((grant) => summarizeGrant(grant)),
		ledgerPath: getPermissionLedgerPath(dataDir),
	};
}

function parsePendingRequestDetails(
	metadata: Record<string, unknown> | undefined,
): TapPendingRequestDetails | undefined {
	if (!metadata || typeof metadata.type !== "string") {
		return undefined;
	}

	if (metadata.type === "connection") {
		return {
			type: "connection",
			peerName: asString(metadata.peerName) ?? "Unknown peer",
			peerChain: asString(metadata.peerChain) ?? "unknown",
			capabilities: asStringArray(metadata.capabilities),
			alreadyActive: metadata.alreadyActive === true,
			requestedGrantSummary: asStringArray(metadata.requestedGrantSummary),
			offeredGrantSummary: asStringArray(metadata.offeredGrantSummary),
		};
	}

	if (metadata.type === "transfer") {
		const toAddress = asString(metadata.toAddress);
		if (!toAddress || !toAddress.startsWith("0x")) {
			return undefined;
		}
		return {
			type: "transfer",
			peerName: asString(metadata.peerName) ?? "Unknown peer",
			peerChain: asString(metadata.peerChain) ?? "unknown",
			asset: metadata.asset === "usdc" ? "usdc" : "native",
			amount: asString(metadata.amount) ?? "0",
			chain: asString(metadata.chain) ?? "unknown",
			toAddress: toAddress as `0x${string}`,
			note: asString(metadata.note),
			activeGrantSummary: asStringArray(metadata.activeGrantSummary),
			ledgerPath: asString(metadata.ledgerPath) ?? "",
		};
	}

	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function serializePendingRequestDetails(
	details: TapPendingRequestDetails,
): Record<string, unknown> {
	return details as unknown as Record<string, unknown>;
}

async function findContactForMessage(
	context: Pick<TapRuntimeContext, "config" | "trustStore">,
	from: number,
	message: ProtocolMessage,
): Promise<Contact | null> {
	const metadataConnectionId = extractConnectionId(message);
	if (metadataConnectionId) {
		const contact = await context.trustStore.getContact(metadataConnectionId);
		if (contact?.peerAgentId === from) {
			return contact;
		}
	}

	if (message.method === CONNECTION_RESULT) {
		const params = parseConnectionResult(message);
		return await context.trustStore.findByAgentId(params.from.agentId, params.from.chain);
	}

	if (message.method === PERMISSIONS_UPDATE) {
		const params = parsePermissionsUpdate(message);
		const peer =
			params.grantor.agentId === context.config.agentId &&
			params.grantor.chain === context.config.chain
				? params.grantee
				: params.grantor;
		return await context.trustStore.findByAgentId(peer.agentId, peer.chain);
	}

	const contacts = await context.trustStore.getContacts();
	return findUniqueContactForAgentId(contacts, from) ?? null;
}

function extractConnectionId(message: ProtocolMessage): string | null {
	if (typeof message.params !== "object" || message.params === null) {
		return null;
	}

	const payload = message.params as {
		message?: {
			metadata?: {
				trustedAgent?: {
					connectionId?: unknown;
				};
			};
		};
	};

	const connectionId = payload.message?.metadata?.trustedAgent?.connectionId;
	return typeof connectionId === "string" && connectionId.length > 0 ? connectionId : null;
}

export { TransportOwnershipError };
