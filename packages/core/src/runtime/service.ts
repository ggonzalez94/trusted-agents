import { parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	AsyncMutex,
	PermissionError,
	TransportError,
	TrustedAgentError,
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
	isSelfInvite,
	parseInviteUrl,
	verifyInvite,
} from "../connection/index.js";
import type { ResolvedAgent } from "../identity/types.js";
import { createEmptyPermissionState, createGrantSet } from "../permissions/index.js";
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
	ConnectionRequestParams,
	ConnectionResultParams,
	PermissionsUpdateParams,
} from "../protocol/types.js";
import {
	buildSchedulingAcceptText,
	buildSchedulingProposalText,
	buildSchedulingRejectText,
	parseSchedulingActionRequest,
	parseSchedulingActionResponse,
} from "../scheduling/actions.js";
import { findApplicableSchedulingGrants } from "../scheduling/grants.js";
import type {
	ConfirmedMeeting,
	ProposedMeeting,
	SchedulingApprovalContext,
	SchedulingHandler,
} from "../scheduling/handler.js";
import type { SchedulingProposal } from "../scheduling/types.js";
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
import { getUsdcAsset } from "./assets.js";
import {
	FileTapCommandOutbox,
	type ProcessingTapCommandJob,
	type TapCommandJobResultPayload,
} from "./command-outbox.js";
import type { TapRuntimeContext } from "./default-context.js";
import {
	findActiveGrantsByScope,
	normalizeGrantInput,
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
import { FilePendingConnectStore, type PendingConnectRecord } from "./pending-connect-store.js";
import {
	type PermissionLedgerEntry,
	appendPermissionLedgerEntry,
	getPermissionLedgerPath,
} from "./permission-ledger.js";
import type { RequestJournalEntry } from "./request-journal.js";
import {
	type TransportOwnerInfo,
	TransportOwnerLock,
	TransportOwnershipError,
} from "./transport-owner-lock.js";

const ACTION_RESULT_WAIT_TIMEOUT_MS = 15_000;
const CONNECT_RECEIPT_TIMEOUT_MS = 5_000;
const OUTBOUND_RESULT_RECEIPT_TIMEOUT_MS = 15_000;
const OUTBOX_POLL_INTERVAL_MS = 1_000;
const OUTBOX_RESULT_RETENTION_MS = 60 * 60 * 1000;
const OUTBOX_RESULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const OUTBOX_STALE_LEASE_MS = 60_000;

export interface TapTransferApprovalContext {
	requestId: string;
	contact: Contact;
	request: TransferActionRequest;
	activeTransferGrants: ReturnType<typeof findActiveGrantsByScope>;
	ledgerPath: string;
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

export interface TapPendingSchedulingDetails {
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

export type TapPendingRequestDetails = TapPendingTransferDetails | TapPendingSchedulingDetails;

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

interface PendingActionResultDelivery extends Record<string, unknown> {
	type: "action-result-delivery";
	actionId: string;
	connectionId: string;
	peerAgentId: number;
	peerName: string;
	peerAddress: `0x${string}`;
	request: ProtocolMessage;
}

interface PendingConnectionResultDelivery extends Record<string, unknown> {
	type: "connection-result-delivery";
	peerAgentId: number;
	peerName: string;
	peerAddress: `0x${string}`;
	request: ProtocolMessage;
}

interface PendingConnectionRequest extends Record<string, unknown> {
	type: "connection-request";
	message: ProtocolMessage;
}

interface RecordedTransferResponseMetadata extends Record<string, unknown> {
	type: "transfer-response";
	response: TransferActionResponse;
}

export interface TapConnectionApprovalContext {
	peerAgentId: number;
	peerName: string;
	peerChain: string;
}

export interface TapServiceHooks {
	approveConnection?: (context: TapConnectionApprovalContext) => Promise<boolean | null>;
	approveTransfer?: (context: TapTransferApprovalContext) => Promise<boolean | null>;
	approveScheduling?: (context: SchedulingApprovalContext) => Promise<boolean | null>;
	confirmMeeting?: (meeting: ProposedMeeting) => Promise<boolean>;
	onMeetingConfirmed?: (meeting: ConfirmedMeeting) => Promise<void>;
	executeTransfer?: (
		config: TrustedAgentsConfig,
		request: TransferActionRequest,
	) => Promise<{ txHash: `0x${string}` }>;
	appendLedgerEntry?: (dataDir: string, entry: PermissionLedgerEntry) => Promise<string>;
	log?: (level: "info" | "warn" | "error", message: string) => void;
	emitEvent?: (payload: Record<string, unknown>) => void;
}

export interface TapServiceOptions {
	ownerLabel?: string;
	commandOutbox?: FileTapCommandOutbox;
	outboxPollIntervalMs?: number;
	outboxResultRetentionMs?: number;
	outboxStaleLeaseMs?: number;
	hooks?: TapServiceHooks;
	schedulingHandler?: SchedulingHandler;
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
	connectionId?: string;
	peerName: string;
	peerAgentId: number;
	status: "active" | "pending";
	receipt?: TransportReceipt;
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

export interface TapRequestMeetingInput {
	peer: string;
	proposal: SchedulingProposal;
}

export interface TapRequestMeetingResult {
	receipt: TransportReceipt;
	schedulingId: string;
	peerName: string;
	peerAgentId: number;
	title: string;
	duration: number;
	slotCount: number;
}

export class TapMessagingService {
	private readonly context: TapRuntimeContext;
	private readonly hooks: TapServiceHooks;
	private readonly ownerLabel: string;
	private readonly ownerLock: TransportOwnerLock;
	private readonly pendingConnectStore: FilePendingConnectStore;
	private readonly localAgentAddress: `0x${string}`;
	private readonly executionMutex = new AsyncMutex();
	private readonly commandOutbox: FileTapCommandOutbox;
	private readonly outboxPollIntervalMs: number;
	private readonly outboxResultRetentionMs: number;
	private readonly outboxStaleLeaseMs: number;
	private readonly pendingTasks = new Set<Promise<void>>();
	private readonly inFlightKeys = new Set<string>();
	private readonly decisionOverrides = {
		transfers: new Map<string, boolean>(),
		scheduling: new Map<string, { approve: boolean; reason?: string }>(),
	};
	private readonly waiters = new Map<string, (value: TransferActionResponse) => void>();
	private readonly schedulingHandler: SchedulingHandler | undefined;
	private readonly handlers: TransportHandlers;
	private running = false;
	private lastSyncAt: string | undefined;
	private lastOutboxCleanupAt = 0;
	private outboxPoller: ReturnType<typeof setInterval> | null = null;
	private outboxPollInFlight = false;
	private transportSessionReentryDepth = 0;

	constructor(context: TapRuntimeContext, options: TapServiceOptions = {}) {
		this.context = context;
		this.hooks = options.hooks ?? {};
		this.ownerLabel = options.ownerLabel ?? `tap:${process.pid}`;
		this.ownerLock = new TransportOwnerLock(context.config.dataDir, this.ownerLabel);
		this.pendingConnectStore = new FilePendingConnectStore(context.config.dataDir);
		this.localAgentAddress = privateKeyToAccount(context.config.privateKey).address;
		this.commandOutbox = options.commandOutbox ?? new FileTapCommandOutbox(context.config.dataDir);
		this.outboxPollIntervalMs = options.outboxPollIntervalMs ?? OUTBOX_POLL_INTERVAL_MS;
		this.outboxResultRetentionMs = options.outboxResultRetentionMs ?? OUTBOX_RESULT_RETENTION_MS;
		this.outboxStaleLeaseMs = options.outboxStaleLeaseMs ?? OUTBOX_STALE_LEASE_MS;
		this.schedulingHandler = options.schedulingHandler;
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
			await this.executionMutex.runExclusive(async () => await this.runMaintenanceCycle(true));
			this.installOutboxPoller();
		} catch (error) {
			this.clearOutboxPoller();
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
			this.clearOutboxPoller();
			await this.drain();
			await this.context.transport.stop?.();
		} finally {
			this.running = false;
			await this.ownerLock.release().catch(() => {});
		}
	}

	async syncOnce(): Promise<TapSyncReport> {
		const processed = await this.executionMutex.runExclusive(
			async () => await this.withTransportSession(async () => await this.runMaintenanceCycle(true)),
		);
		return await this.buildSyncReport(processed);
	}

	async processOutboxOnce(): Promise<number> {
		return await this.executionMutex.runExclusive(
			async () => await this.withTransportSession(async () => await this.processOutboxInternal()),
		);
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
		const pending = (await this.context.requestJournal.listPending()).filter(
			(entry) => entry.kind === "request",
		);
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

	async resolvePending(
		requestId: string,
		approve: boolean,
		reason?: string,
	): Promise<TapSyncReport> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		if (!entry || entry.direction !== "inbound" || entry.kind !== "request") {
			throw new ValidationError(`Pending inbound request not found: ${requestId}`);
		}

		if (entry.method !== ACTION_REQUEST && entry.method !== CONNECTION_REQUEST) {
			throw new ValidationError(`Request ${requestId} cannot be resolved manually`);
		}

		const isScheduling = entry.method === ACTION_REQUEST && entry.metadata?.type === "scheduling";
		if (entry.method === ACTION_REQUEST) {
			if (isScheduling) {
				this.decisionOverrides.scheduling.set(requestId, { approve, reason });
			} else {
				this.decisionOverrides.transfers.set(requestId, approve);
			}
		}
		try {
			return await this.executionMutex.runExclusive(
				async () =>
					await this.withTransportSession(async () => {
						await this.drain();
						const latestEntry = await this.context.requestJournal.getByRequestId(requestId);
						if (
							!latestEntry ||
							latestEntry.direction !== "inbound" ||
							latestEntry.kind !== "request"
						) {
							throw new ValidationError(`Pending inbound request not found: ${requestId}`);
						}
						if (latestEntry.status === "completed") {
							return await this.buildSyncReport(0);
						}

						if (latestEntry.method === ACTION_REQUEST) {
							const latestIsScheduling = latestEntry.metadata?.type === "scheduling";
							if (latestIsScheduling) {
								await this.resolvePendingSchedulingRequest(latestEntry);
							} else {
								await this.resolvePendingTransferRequest(latestEntry);
							}
						} else if (latestEntry.method === CONNECTION_REQUEST) {
							await this.resolvePendingConnectionRequest(latestEntry, approve);
						} else {
							throw new ValidationError(`Request ${requestId} cannot be resolved manually`);
						}

						await this.drain();
						return await this.buildSyncReport(1);
					}),
			);
		} finally {
			if (entry.method === ACTION_REQUEST) {
				if (isScheduling) {
					this.decisionOverrides.scheduling.delete(requestId);
				} else {
					this.decisionOverrides.transfers.delete(requestId);
				}
			}
		}
	}

	async connect(params: { inviteUrl: string }): Promise<TapConnectResult> {
		return await this.executionMutex.runExclusive(async () => await this.connectInternal(params));
	}

	async cancelPendingSchedulingRequest(
		requestId: string,
		reason?: string,
	): Promise<TapSyncReport> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		if (!entry || entry.direction !== "outbound" || entry.kind !== "request") {
			throw new ValidationError(`Pending outbound request not found: ${requestId}`);
		}
		if (entry.method !== ACTION_REQUEST) {
			throw new ValidationError(`Request ${requestId} cannot be cancelled manually`);
		}

		if (!parseStoredSchedulingRequest(entry.metadata)) {
			throw new ValidationError(
				`Pending scheduling request ${requestId} is missing the original request payload`,
			);
		}

		return await this.executionMutex.runExclusive(
			async () =>
				await this.withTransportSession(async () => {
					await this.drain();
					const latestEntry = await this.context.requestJournal.getByRequestId(requestId);
					if (!latestEntry || latestEntry.direction !== "outbound" || latestEntry.kind !== "request") {
						throw new ValidationError(`Pending outbound request not found: ${requestId}`);
					}
					if (latestEntry.status === "completed") {
						return await this.buildSyncReport(0);
					}

					const latestProposal = parseStoredSchedulingRequest(latestEntry.metadata);
					if (!latestProposal) {
						throw new ValidationError(
							`Pending scheduling request ${requestId} is missing the original request payload`,
						);
					}

					const contact = findUniqueContactForAgentId(
						await this.context.trustStore.getContacts(),
						latestEntry.peerAgentId,
					);
					if (!contact) {
						throw new ValidationError(
							`No active contact found for pending scheduling request ${requestId}`,
						);
					}

					const cancellation = {
						type: "scheduling/cancel" as const,
						schedulingId: latestProposal.schedulingId,
						...(reason ? { reason } : {}),
					};
					const outgoing = buildOutgoingActionResult(
						contact,
						latestEntry.requestId,
						buildSchedulingRejectText(cancellation),
						cancellation,
						"scheduling/request",
						"rejected",
					);

					await this.context.transport.send(contact.peerAgentId, outgoing, {
						peerAddress: contact.peerAgentAddress,
						timeout: OUTBOUND_RESULT_RECEIPT_TIMEOUT_MS,
					});
					await this.appendConversationLogSafe(contact, outgoing, "outgoing");
					await this.touchContactSafe(contact.connectionId);

					await this.context.requestJournal.updateStatus(requestId, "completed");
					await this.appendLedger({
						peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
						direction: "local",
						event: "scheduling-cancel",
						scope: "scheduling/request",
						action_id: latestProposal.schedulingId,
						decision: "cancelled",
						rationale: reason ?? "Cancelled by operator",
					});

					await this.drain();
					return await this.buildSyncReport(1);
				}),
		);
	}

	private async connectInternal(params: { inviteUrl: string }): Promise<TapConnectResult> {
		const { config, resolver } = this.context;
		const chainId = caip2ToChainId(config.chain);
		if (chainId === null) {
			throw new ValidationError(`Invalid local chain format: ${config.chain}`);
		}

		const invite = parseInviteUrl(params.inviteUrl);
		if (isSelfInvite(invite, { agentId: config.agentId, chain: config.chain })) {
			throw new ValidationError(
				"Cannot connect to your own invite. Switch to a different TAP identity or --data-dir before accepting it.",
			);
		}
		const peerAgent = await resolver.resolve(invite.agentId, invite.chain);
		const verification = await verifyInvite(invite, {
			expectedSignerAddress: peerAgent.agentAddress,
		});
		if (!verification.valid) {
			throw new ValidationError(verification.error ?? "Invite verification failed");
		}

		return await this.withTransportSession(async () => {
			const { trustStore, transport } = this.context;

			const existing = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
			if (existing?.status === "active") {
				return {
					connectionId: existing.connectionId,
					peerName: existing.peerDisplayName,
					peerAgentId: existing.peerAgentId,
					status: "active",
				};
			}

			const from: AgentIdentifier = { agentId: config.agentId, chain: config.chain };
			const requestedAt = nowISO();
			const requestParams: ConnectionRequestParams = {
				from,
				invite,
				timestamp: requestedAt,
			};

			const rpcRequest = buildConnectionRequest(requestParams);
			const requestId = String(rpcRequest.id);
			const pendingConnect: PendingConnectRecord = {
				requestId,
				peerAgentId: peerAgent.agentId,
				peerChain: peerAgent.chain,
				peerOwnerAddress: peerAgent.ownerAddress,
				peerDisplayName: peerAgent.registrationFile.name,
				peerAgentAddress: peerAgent.agentAddress,
				createdAt: requestedAt,
			};
			await this.pendingConnectStore.replaceForPeer(pendingConnect);

			let receipt: TransportReceipt | undefined;
			try {
				receipt = await transport.send(peerAgent.agentId, rpcRequest, {
					peerAddress: peerAgent.xmtpEndpoint ?? peerAgent.agentAddress,
					timeout: CONNECT_RECEIPT_TIMEOUT_MS,
				});
			} catch (error: unknown) {
				if (!isTransportReceiptTimeout(error)) {
					await this.pendingConnectStore.delete(requestId);
					throw error;
				}
			}

			const latestContact = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
			const pendingRecord = await this.pendingConnectStore.get(requestId);
			if (!latestContact && !pendingRecord) {
				throw new ValidationError(
					`Connection rejected by ${peerAgent.registrationFile.name} (#${peerAgent.agentId})`,
				);
			}
			const status = latestContact?.status === "active" ? "active" : "pending";

			return {
				connectionId: latestContact?.connectionId,
				peerName: latestContact?.peerDisplayName ?? peerAgent.registrationFile.name,
				peerAgentId: peerAgent.agentId,
				status,
				receipt,
			};
		});
	}

	async sendMessage(
		peer: string,
		text: string,
		scope = DEFAULT_MESSAGE_SCOPE,
	): Promise<TapSendMessageResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.sendMessageInternal(peer, text, scope),
		);
	}

	private async sendMessageInternal(
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
		return await this.executionMutex.runExclusive(
			async () => await this.publishGrantSetInternal(peer, grantSet, note),
		);
	}

	private async publishGrantSetInternal(
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
		return await this.executionMutex.runExclusive(
			async () => await this.requestGrantSetInternal(peer, grantSet, note),
		);
	}

	private async requestGrantSetInternal(
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
		return await this.executionMutex.runExclusive(
			async () => await this.requestFundsInternal(input),
		);
	}

	private async requestFundsInternal(input: TapRequestFundsInput): Promise<TapRequestFundsResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(input.peer);
			const peerTransferGrants = findActiveGrantsByScope(
				contact.permissions.grantedByPeer,
				"transfer/request",
			);
			if (peerTransferGrants.length === 0) {
				this.log(
					"warn",
					`No matching transfer/request grant found in grantedByPeer for ${contact.peerDisplayName}. The peer may reject this request.`,
				);
			}
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

			await this.context.requestJournal.putOutbound({
				requestId,
				requestKey: `outbound:${request.method}:${requestId}`,
				direction: "outbound",
				kind: "request",
				method: request.method,
				peerAgentId: contact.peerAgentId,
				status: "pending",
			});
			const waiter = this.registerActionResultWaiter(
				requestId,
				requestPayload.actionId,
				ACTION_RESULT_WAIT_TIMEOUT_MS,
			);

			let receipt: TransportReceipt;
			try {
				receipt = await this.context.transport.send(contact.peerAgentId, request, {
					peerAddress: contact.peerAgentAddress,
				});
			} catch (error: unknown) {
				waiter.cancel();
				if (!isTransportReceiptTimeout(error)) {
					await this.context.requestJournal.delete(requestId);
				}
				throw error;
			}

			const journalEntry = await this.context.requestJournal.getByRequestId(requestId);
			if (journalEntry?.status !== "completed") {
				await this.context.requestJournal.updateStatus(requestId, "acked");
			}
			await this.appendConversationLogSafe(contact, request, "outgoing", timestamp);
			await this.touchContactSafe(contact.connectionId);

			const asyncResult = await waiter.promise;
			if (!asyncResult) {
				await this.runReconcile();
			}
			await this.drain();
			const settledResult =
				asyncResult ?? (await this.readRecordedTransferResponse(requestId)) ?? undefined;

			if (settledResult?.status === "rejected") {
				throw new PermissionError(settledResult.error ?? "Action rejected by agent");
			}
			if (settledResult?.status === "failed") {
				throw new Error(settledResult.error ?? "Transfer request failed");
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
				asyncResult: settledResult,
			};
		});
	}

	async requestMeeting(input: TapRequestMeetingInput): Promise<TapRequestMeetingResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.requestMeetingInternal(input),
		);
	}

	private async requestMeetingInternal(
		input: TapRequestMeetingInput,
	): Promise<TapRequestMeetingResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(input.peer);
			const { proposal } = input;
			const peerSchedulingGrants = findActiveGrantsByScope(
				contact.permissions.grantedByPeer,
				"scheduling/request",
			);
			if (peerSchedulingGrants.length === 0) {
				this.log(
					"warn",
					`No matching scheduling/request grant found in grantedByPeer for ${contact.peerDisplayName}. The peer may reject this request.`,
				);
			}

			const request = buildOutgoingActionRequest(
				contact,
				buildSchedulingProposalText(proposal),
				proposal as unknown as Record<string, unknown>,
				"scheduling/request",
			);
			const requestId = String(request.id);
			const timestamp = nowISO();

			await this.appendLedger({
				timestamp,
				peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
				direction: "local",
				event: "scheduling-request-sent",
				scope: "scheduling/request",
				action_id: proposal.schedulingId,
				note: proposal.note ?? `Meeting: ${proposal.title}`,
			});

			await this.context.requestJournal.putOutbound({
				requestId,
				requestKey: `outbound:${request.method}:${requestId}`,
				direction: "outbound",
				kind: "request",
				method: request.method,
				peerAgentId: contact.peerAgentId,
				status: "pending",
				metadata: serializePendingSchedulingOutboundRequestDetails(
					contact,
					proposal,
					this.context.config.dataDir,
				),
			});

			let receipt: TransportReceipt;
			try {
				receipt = await this.context.transport.send(contact.peerAgentId, request, {
					peerAddress: contact.peerAgentAddress,
				});
			} catch (error: unknown) {
				if (!isTransportReceiptTimeout(error)) {
					await this.context.requestJournal.delete(requestId);
				}
				throw error;
			}

			const journalEntry = await this.context.requestJournal.getByRequestId(requestId);
			if (journalEntry?.status !== "completed") {
				await this.context.requestJournal.updateStatus(requestId, "acked");
			}
			await this.appendConversationLogSafe(contact, request, "outgoing", timestamp);
			await this.touchContactSafe(contact.connectionId);

			return {
				receipt,
				schedulingId: proposal.schedulingId,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				title: proposal.title,
				duration: proposal.duration,
				slotCount: proposal.slots.length,
			};
		});
	}

	private async runMaintenanceCycle(reconcile: boolean): Promise<number> {
		if (!reconcile) {
			return await this.processOutboxInternal();
		}
		const reconciled = await this.runReconcile();
		const outboxProcessed = await this.processOutboxInternal();
		return reconciled + outboxProcessed;
	}

	private async processOutboxInternal(): Promise<number> {
		await this.cleanupOutboxResultsIfDue();
		let processed = await this.retryPendingConnectionRequests();
		processed += await this.retryPendingConnectionResults();
		processed += await this.retryPendingActionResults();
		while (true) {
			const job = await this.commandOutbox.claimNext({
				owner: this.ownerLabel,
				staleLeaseMs: this.outboxStaleLeaseMs,
			});
			if (!job) {
				return processed;
			}

			try {
				const result = await this.executeOutboxJob(job);
				await this.commandOutbox.complete(job, result);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				await this.commandOutbox.fail(
					job,
					message,
					error instanceof TrustedAgentError ? error.code : undefined,
				);
				this.log("error", `Failed queued TAP job ${job.jobId} (${job.type}): ${message}`);
			}
			processed += 1;
		}
	}

	private async executeOutboxJob(
		job: ProcessingTapCommandJob,
	): Promise<TapCommandJobResultPayload> {
		switch (job.type) {
			case "connect":
				return await this.connectInternal(job.payload);
			case "send-message":
				return await this.sendMessageInternal(
					job.payload.peer,
					job.payload.text,
					job.payload.scope,
				);
			case "publish-grant-set":
				return await this.publishGrantSetInternal(
					job.payload.peer,
					job.payload.grantSet,
					job.payload.note,
				);
			case "request-grant-set":
				return await this.requestGrantSetInternal(
					job.payload.peer,
					job.payload.grantSet,
					job.payload.note,
				);
			case "request-funds":
				return await this.requestFundsInternal(job.payload.input);
			case "request-meeting":
				return await this.requestMeetingInternal(job.payload.input);
			default:
				return assertNever(job);
		}
	}

	private installOutboxPoller(): void {
		if (this.outboxPollIntervalMs <= 0 || this.outboxPoller) {
			return;
		}
		this.outboxPoller = setInterval(() => {
			void this.tickOutboxPoller();
		}, this.outboxPollIntervalMs);
	}

	private clearOutboxPoller(): void {
		if (!this.outboxPoller) {
			return;
		}
		clearInterval(this.outboxPoller);
		this.outboxPoller = null;
	}

	private async tickOutboxPoller(): Promise<void> {
		if (!this.running || this.outboxPollInFlight) {
			return;
		}
		this.outboxPollInFlight = true;
		try {
			await this.executionMutex.runExclusive(async () => await this.processOutboxInternal());
		} catch (error: unknown) {
			this.log(
				"warn",
				`Queued TAP command polling failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.outboxPollInFlight = false;
		}
	}

	private async withTransportSession<T>(task: () => Promise<T>): Promise<T> {
		if (this.running || this.transportSessionReentryDepth > 0) {
			return await task();
		}

		await this.ownerLock.acquire();
		this.transportSessionReentryDepth += 1;
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
			this.transportSessionReentryDepth -= 1;
			await this.ownerLock.release().catch(() => {});
		}
	}

	private async cleanupOutboxResultsIfDue(): Promise<void> {
		const now = Date.now();
		if (now - this.lastOutboxCleanupAt < OUTBOX_RESULT_CLEANUP_INTERVAL_MS) {
			return;
		}
		await this.commandOutbox.cleanupResults(this.outboxResultRetentionMs);
		this.lastOutboxCleanupAt = now;
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
		try {
			this.hooks.emitEvent?.({
				timestamp: nowISO(),
				...payload,
			});
		} catch (error: unknown) {
			this.log(
				"warn",
				`emitEvent hook threw: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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

	private async appendConversationLogSafe(
		contact: Contact,
		request: ProtocolMessage,
		direction: "incoming" | "outgoing",
		timestamp?: string,
	): Promise<void> {
		try {
			await appendConversationLog(
				this.context.conversationLogger,
				contact,
				request,
				direction,
				timestamp,
			);
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to record conversation log for ${contact.peerDisplayName} (#${contact.peerAgentId}): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async touchContactSafe(connectionId: string): Promise<void> {
		try {
			await this.context.trustStore.touchContact(connectionId);
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to update contact activity for ${connectionId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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

	private registerActionResultWaiter(
		requestId: string,
		actionId: string,
		timeoutMs: number,
	): {
		promise: Promise<TransferActionResponse | null>;
		cancel: () => void;
	} {
		let settle: (value: TransferActionResponse | null) => void = () => {};
		const promise = new Promise<TransferActionResponse | null>((resolve) => {
			settle = resolve;
		});
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			finish(null);
		}, timeoutMs);

		const finish = (value: TransferActionResponse | null) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
				timeout = null;
			}
			if (this.waiters.get(requestId) === onResult) {
				this.waiters.delete(requestId);
			}
			settle(value);
		};

		const onResult = (value: TransferActionResponse) => {
			if (value.actionId !== actionId) {
				return;
			}
			finish(value);
		};

		this.waiters.set(requestId, onResult);
		return {
			promise,
			cancel: () => finish(null),
		};
	}

	private async readRecordedTransferResponse(
		requestId: string,
	): Promise<TransferActionResponse | null> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		return parseRecordedTransferResponse(entry?.metadata);
	}

	private async onRequest(envelope: {
		from: number;
		senderInboxId: string;
		message: ProtocolMessage;
	}): Promise<{ status: "received" | "duplicate" | "queued" }> {
		const requestKey = buildRequestKey(envelope.senderInboxId, envelope.message);
		if (envelope.message.method === CONNECTION_REQUEST) {
			const claimed = await this.context.requestJournal.claimInbound({
				requestId: String(envelope.message.id),
				requestKey,
				direction: "inbound",
				kind: "request",
				method: envelope.message.method,
				peerAgentId: envelope.from,
				metadata: serializePendingConnectionRequest(envelope.message),
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

			this.enqueue(requestKey, async () => {
				const result = await this.processConnectionRequest(envelope.message);
				if (result === "processed") {
					await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
				}
			});
			this.emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: claimed.duplicate ? "duplicate" : "queued",
			});
			return { status: claimed.duplicate ? "duplicate" : "queued" };
		}

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
				fromName: contact.peerDisplayName,
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
				fromName: contact.peerDisplayName,
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
				fromName: contact.peerDisplayName,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: status,
			});
			return { status };
		}

		const schedulingRequest = parseSchedulingActionRequest(envelope.message);
		if (schedulingRequest) {
			await this.context.requestJournal.updateMetadata(
				String(envelope.message.id),
				serializePendingSchedulingRequestDetails(
					contact,
					schedulingRequest,
					this.context.config.dataDir,
				),
			);

			this.enqueue(requestKey, async () => {
				await this.processSchedulingRequest(
					contact,
					String(envelope.message.id),
					schedulingRequest,
				);
			});

			const status = claimed.duplicate ? "duplicate" : "queued";
			this.emitEvent({
				direction: "incoming",
				from: envelope.from,
				fromName: contact.peerDisplayName,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: status,
				scope: "scheduling/request",
			});
			return { status };
		}

		const transferRequest = parseTransferActionRequest(envelope.message);
		if (!transferRequest) {
			throw new ValidationError("Unsupported action request payload");
		}
		await this.context.requestJournal.updateMetadata(
			String(envelope.message.id),
			serializePendingTransferRequestDetails(contact, transferRequest, this.context.config.dataDir),
		);

		this.enqueue(requestKey, async () => {
			await this.processTransferRequest(contact, String(envelope.message.id), transferRequest);
		});
		const status = claimed.duplicate ? "duplicate" : "queued";
		this.emitEvent({
			direction: "incoming",
			from: envelope.from,
			fromName: contact.peerDisplayName,
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
		if (envelope.message.method === CONNECTION_RESULT) {
			const status = await this.handleConnectionResult(envelope.message);
			this.emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: status,
			});
			return { status };
		}

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

		let peerName: string | undefined;
		if (envelope.message.method === ACTION_RESULT) {
			peerName = await this.handleActionResult(envelope.from, envelope.message);
		} else {
			throw new ValidationError(`Unsupported result method: ${envelope.message.method}`);
		}

		await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
		const status = claimed.duplicate ? "duplicate" : "received";
		this.emitEvent({
			direction: "incoming",
			from: envelope.from,
			...(peerName ? { fromName: peerName } : {}),
			method: envelope.message.method,
			id: envelope.message.id,
			receipt_status: status,
		});
		return { status };
	}

	private async processConnectionRequest(
		message: ProtocolMessage,
		options?: { skipApprovalHook?: boolean },
	): Promise<"processed" | "deferred"> {
		const params = parseConnectionRequest(message);

		// Cheap local check first — avoids resolving a peer for misrouted requests
		const inviteRejectionReason = await this.validateInboundInvite(params.invite);
		if (inviteRejectionReason) {
			const peer = await this.context.resolver.resolveWithCache(
				params.from.agentId,
				params.from.chain,
			);
			await this.sendConnectionResult(peer, {
				requestId: String(message.id),
				from: { agentId: this.context.config.agentId, chain: this.context.config.chain },
				status: "rejected",
				reason: inviteRejectionReason,
				timestamp: nowISO(),
			});
			this.log(
				"warn",
				`Rejected connection request from ${peer.registrationFile.name} (#${peer.agentId}): ${inviteRejectionReason}`,
			);
			return "processed";
		}

		if (this.hooks.approveConnection && !options?.skipApprovalHook) {
			const peer = await this.context.resolver.resolveWithCache(
				params.from.agentId,
				params.from.chain,
			);
			const decision = await this.hooks.approveConnection({
				peerAgentId: peer.agentId,
				peerName: peer.registrationFile.name,
				peerChain: peer.chain,
			});
			if (decision === null) {
				this.log(
					"info",
					`Deferred connection request from ${peer.registrationFile.name} (#${peer.agentId}); resolve it later with resolvePending`,
				);
				return "deferred";
			}
			if (decision === false) {
				await this.sendConnectionResult(peer, {
					requestId: String(message.id),
					from: { agentId: this.context.config.agentId, chain: this.context.config.chain },
					status: "rejected",
					reason: "Connection request declined by operator",
					timestamp: nowISO(),
				});
				this.log(
					"info",
					`Rejected connection request from ${peer.registrationFile.name} (#${peer.agentId}) via approveConnection hook`,
				);
				return "processed";
			}
		}

		const outcome = await handleConnectionRequest({
			message,
			resolver: this.context.resolver,
			trustStore: this.context.trustStore,
			ownAgent: { agentId: this.context.config.agentId, chain: this.context.config.chain },
		});
		await this.sendConnectionResult(outcome.peer, outcome.result);

		this.log(
			"info",
			`Accepted connection request from ${outcome.peer.registrationFile.name} (#${outcome.peer.agentId})`,
		);
		return "processed";
	}

	private async validateInboundInvite(
		invite: ConnectionRequestParams["invite"],
	): Promise<string | null> {
		if (
			invite.agentId !== this.context.config.agentId ||
			invite.chain !== this.context.config.chain
		) {
			return "Invite does not target the local agent";
		}

		const verification = await verifyInvite(invite, {
			expectedSignerAddress: this.localAgentAddress,
		});
		if (!verification.valid) {
			return verification.error ?? "Invite verification failed";
		}

		return null;
	}

	private async handlePermissionsUpdate(contact: Contact, message: ProtocolMessage): Promise<void> {
		const update = parsePermissionsUpdate(message);
		const peer = resolvePermissionsUpdatePeer(this.context.config, update);
		if (peer.agentId !== contact.peerAgentId || peer.chain !== contact.peerChain) {
			throw new ValidationError("Grant update does not match the sending contact");
		}
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

	private async resolvePendingTransferRequest(entry: RequestJournalEntry): Promise<void> {
		const request = parseStoredTransferRequest(entry.metadata);
		if (!request) {
			throw new ValidationError(
				`Pending action request ${entry.requestId} is missing the original request payload`,
			);
		}

		const contact = findUniqueContactForAgentId(
			await this.context.trustStore.getContacts(),
			entry.peerAgentId,
		);
		if (!contact) {
			throw new ValidationError(
				`No active contact found for pending action request ${entry.requestId}`,
			);
		}

		await this.processTransferRequest(contact, entry.requestId, request);
	}

	private async resolvePendingConnectionRequest(
		entry: RequestJournalEntry,
		approve: boolean,
	): Promise<void> {
		const pendingRequest = parsePendingConnectionRequest(entry.metadata);
		if (!pendingRequest) {
			throw new ValidationError(`Cannot parse pending connection request: ${entry.requestId}`);
		}

		if (approve) {
			await this.processConnectionRequest(pendingRequest.message, { skipApprovalHook: true });
		} else {
			const params = parseConnectionRequest(pendingRequest.message);
			const peer = await this.context.resolver.resolveWithCache(
				params.from.agentId,
				params.from.chain,
			);
			await this.sendConnectionResult(peer, {
				requestId: entry.requestId,
				from: { agentId: this.context.config.agentId, chain: this.context.config.chain },
				status: "rejected",
				reason: "Connection request declined by operator",
				timestamp: nowISO(),
			});
		}
		await this.context.requestJournal.updateStatus(entry.requestId, "completed");
	}

	private async resolvePendingSchedulingRequest(entry: RequestJournalEntry): Promise<void> {
		const proposal = parseStoredSchedulingRequest(entry.metadata);
		if (!proposal) {
			throw new ValidationError(
				`Pending scheduling request ${entry.requestId} is missing the original request payload`,
			);
		}

		const contact = findUniqueContactForAgentId(
			await this.context.trustStore.getContacts(),
			entry.peerAgentId,
		);
		if (!contact) {
			throw new ValidationError(
				`No active contact found for pending scheduling request ${entry.requestId}`,
			);
		}

		await this.processSchedulingRequest(contact, entry.requestId, proposal);
	}

	private async processTransferRequest(
		contact: Contact,
		requestId: string,
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

		const delivery = buildPendingActionResultDelivery(contact, requestId, response);
		await this.context.requestJournal.updateStatus(requestId, "completed");
		// The on-chain transfer is irreversible at this point, so complete the inbound
		// request before attempting any retry bookkeeping to avoid duplicate execution.
		try {
			await this.context.requestJournal.putOutbound({
				requestId: String(delivery.request.id),
				requestKey: `outbound:${delivery.request.method}:${String(delivery.request.id)}`,
				direction: "outbound",
				kind: "result",
				method: delivery.request.method,
				peerAgentId: contact.peerAgentId,
				correlationId: requestId,
				status: "pending",
				metadata: serializePendingActionResultDelivery(delivery),
			});
		} catch (error: unknown) {
			this.log(
				"error",
				`Failed to persist retry metadata for action result ${response.actionId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			try {
				await this.context.transport.send(contact.peerAgentId, delivery.request, {
					peerAddress: contact.peerAgentAddress,
					timeout: OUTBOUND_RESULT_RECEIPT_TIMEOUT_MS,
				});
				await this.appendConversationLogSafe(contact, delivery.request, "outgoing");
				await this.touchContactSafe(contact.connectionId);
			} catch (deliveryError: unknown) {
				this.logActionResultDeliveryFailure(contact, response.actionId, deliveryError);
			}
			return;
		}
		try {
			await this.deliverPendingActionResult(delivery);
		} catch (error: unknown) {
			this.logActionResultDeliveryFailure(contact, response.actionId, error);
		}
	}

	private async processSchedulingRequest(
		contact: Contact,
		requestId: string,
		proposal: SchedulingProposal,
	): Promise<void> {
		if (!this.schedulingHandler) {
			this.log(
				"warn",
				`No scheduling handler configured — scheduling request ${requestId} stays pending`,
			);
			return;
		}

		const override = this.decisionOverrides.scheduling.get(requestId);
		const evaluatedDecision = await this.schedulingHandler.evaluateProposal(
			requestId,
			contact,
			proposal,
		);
		const decision =
			override?.approve === false
				? ({
						action: "reject",
						reason: override.reason ?? "Scheduling request declined by operator",
					} as const)
				: override?.approve === true && evaluatedDecision.action !== "confirm"
					? ({
							action: "confirm",
							slot: proposal.slots[0],
							proposal,
						} as const)
					: evaluatedDecision;

		switch (decision.action) {
			case "confirm": {
				const selectedSlot = decision.slot ?? proposal.slots[0];
				if (!selectedSlot) {
					throw new ValidationError(
						`Scheduling request ${proposal.schedulingId} has no proposed slots`,
					);
				}
				const confirmed =
					override?.approve === true
						? true
						: this.hooks.confirmMeeting
							? await this.hooks.confirmMeeting({
									schedulingId: proposal.schedulingId,
									title: proposal.title,
									slot: selectedSlot,
									peerName: contact.peerDisplayName,
									peerAgentId: contact.peerAgentId,
									originTimezone: proposal.originTimezone,
								})
							: false;

				if (confirmed) {
					const eventResult = await this.schedulingHandler.handleAccept(
						{
							type: "scheduling/accept",
							schedulingId: proposal.schedulingId,
							acceptedSlot: selectedSlot,
						},
						contact.peerDisplayName,
						proposal.title,
						proposal.originTimezone,
					);

					const acceptData: Record<string, unknown> = {
						type: "scheduling/accept",
						schedulingId: proposal.schedulingId,
						acceptedSlot: selectedSlot,
						...(eventResult.eventId ? { eventId: eventResult.eventId } : {}),
					};
					const acceptText = buildSchedulingAcceptText({
						type: "scheduling/accept",
						schedulingId: proposal.schedulingId,
						acceptedSlot: selectedSlot,
					});
					const outgoing = buildOutgoingActionResult(
						contact,
						requestId,
						acceptText,
						acceptData,
						"scheduling/request",
						"completed",
					);

					try {
						await this.context.transport.send(contact.peerAgentId, outgoing, {
							peerAddress: contact.peerAgentAddress,
							timeout: OUTBOUND_RESULT_RECEIPT_TIMEOUT_MS,
						});
						await this.appendConversationLogSafe(contact, outgoing, "outgoing");
						await this.touchContactSafe(contact.connectionId);
					} catch (error: unknown) {
						this.log(
							"warn",
							`Failed to deliver scheduling accept for ${proposal.schedulingId}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}

					await this.context.requestJournal.updateStatus(requestId, "completed");
					await this.appendLedger({
						peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
						direction: "granted-by-me",
						event: "scheduling-accepted",
						scope: "scheduling/request",
						action_id: proposal.schedulingId,
						decision: "accepted",
					});

					if (this.hooks.onMeetingConfirmed) {
						await this.hooks.onMeetingConfirmed({
							schedulingId: proposal.schedulingId,
							title: proposal.title,
							slot: selectedSlot,
							peerName: contact.peerDisplayName,
							peerAgentId: contact.peerAgentId,
							originTimezone: proposal.originTimezone,
							eventId: eventResult.eventId,
						});
					}
					break;
				}

				const rejectData: Record<string, unknown> = {
					type: "scheduling/reject",
					schedulingId: proposal.schedulingId,
					reason: "Scheduling request declined by operator",
				};
				const rejectText = buildSchedulingRejectText({
					type: "scheduling/reject",
					schedulingId: proposal.schedulingId,
					reason: "Scheduling request declined by operator",
				});
				const outgoing = buildOutgoingActionResult(
					contact,
					requestId,
					rejectText,
					rejectData,
					"scheduling/request",
					"rejected",
				);

				try {
					await this.context.transport.send(contact.peerAgentId, outgoing, {
						peerAddress: contact.peerAgentAddress,
						timeout: OUTBOUND_RESULT_RECEIPT_TIMEOUT_MS,
					});
					await this.appendConversationLogSafe(contact, outgoing, "outgoing");
					await this.touchContactSafe(contact.connectionId);
				} catch (error: unknown) {
					this.log(
						"warn",
						`Failed to deliver scheduling reject for ${proposal.schedulingId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				await this.context.requestJournal.updateStatus(requestId, "completed");
				await this.appendLedger({
					peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
					direction: "granted-by-me",
					event: "scheduling-rejected",
					scope: "scheduling/request",
					action_id: proposal.schedulingId,
					decision: "rejected",
					rationale: "Scheduling request declined by operator",
				});
				break;
			}
			case "counter": {
				const counterData: Record<string, unknown> = {
					type: "scheduling/counter",
					schedulingId: proposal.schedulingId,
					title: proposal.title,
					duration: proposal.duration,
					slots: decision.slots,
					originTimezone: proposal.originTimezone,
				};
				const counterText = buildSchedulingProposalText({
					type: "scheduling/counter",
					schedulingId: proposal.schedulingId,
					title: proposal.title,
					duration: proposal.duration,
					slots: decision.slots,
					originTimezone: proposal.originTimezone,
				});
				const outgoing = buildOutgoingActionRequest(
					contact,
					counterText,
					counterData,
					"scheduling/request",
				);

				try {
					await this.context.transport.send(contact.peerAgentId, outgoing, {
						peerAddress: contact.peerAgentAddress,
					});
					await this.appendConversationLogSafe(contact, outgoing, "outgoing");
					await this.touchContactSafe(contact.connectionId);
				} catch (error: unknown) {
					this.log(
						"warn",
						`Failed to deliver scheduling counter for ${proposal.schedulingId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				await this.context.requestJournal.updateStatus(requestId, "completed");
				await this.appendLedger({
					peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
					direction: "local",
					event: "scheduling-counter",
					scope: "scheduling/request",
					action_id: proposal.schedulingId,
					decision: "counter",
				});
				break;
			}
			case "reject": {
				const rejectData: Record<string, unknown> = {
					type: "scheduling/reject",
					schedulingId: proposal.schedulingId,
					reason: decision.reason,
				};
				const rejectText = buildSchedulingRejectText({
					type: "scheduling/reject",
					schedulingId: proposal.schedulingId,
					reason: decision.reason,
				});
				const outgoing = buildOutgoingActionResult(
					contact,
					requestId,
					rejectText,
					rejectData,
					"scheduling/request",
					"rejected",
				);

				try {
					await this.context.transport.send(contact.peerAgentId, outgoing, {
						peerAddress: contact.peerAgentAddress,
						timeout: OUTBOUND_RESULT_RECEIPT_TIMEOUT_MS,
					});
					await this.appendConversationLogSafe(contact, outgoing, "outgoing");
					await this.touchContactSafe(contact.connectionId);
				} catch (error: unknown) {
					this.log(
						"warn",
						`Failed to deliver scheduling reject for ${proposal.schedulingId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				await this.context.requestJournal.updateStatus(requestId, "completed");
				await this.appendLedger({
					peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
					direction: "granted-by-me",
					event: "scheduling-rejected",
					scope: "scheduling/request",
					action_id: proposal.schedulingId,
					decision: "rejected",
					rationale: decision.reason,
				});
				break;
			}
			case "defer":
				this.log(
					"info",
					`Scheduling request ${proposal.schedulingId} deferred for manual decision`,
				);
				break;
		}
	}

	private async handleConnectionResult(
		message: ProtocolMessage,
	): Promise<"received" | "duplicate"> {
		const result = parseConnectionResult(message);
		const [pendingConnect, existingContact] = await Promise.all([
			this.pendingConnectStore.get(result.requestId),
			this.context.trustStore.findByAgentId(result.from.agentId, result.from.chain),
		]);

		if (!pendingConnect) {
			if (existingContact?.status === "active") {
				this.log(
					"info",
					`Ignoring duplicate connection result from ${existingContact.peerDisplayName} (#${existingContact.peerAgentId})`,
				);
				return "duplicate";
			}
			this.log(
				"warn",
				`Ignoring unsolicited connection result from agent #${result.from.agentId} on ${result.from.chain}`,
			);
			return "duplicate";
		}

		if (
			pendingConnect.peerAgentId !== result.from.agentId ||
			pendingConnect.peerChain !== result.from.chain
		) {
			throw new ValidationError("Connection result sender does not match the pending connect");
		}

		if (result.status === "rejected") {
			await this.pendingConnectStore.delete(result.requestId);
			this.log(
				"info",
				`Connection rejected by ${pendingConnect.peerDisplayName} (#${pendingConnect.peerAgentId})`,
			);
			return "received";
		}

		const establishedAt = result.timestamp;
		const nextContact: Contact = {
			connectionId: existingContact?.connectionId ?? generateConnectionId(),
			peerAgentId: pendingConnect.peerAgentId,
			peerChain: pendingConnect.peerChain,
			peerOwnerAddress: pendingConnect.peerOwnerAddress,
			peerDisplayName: pendingConnect.peerDisplayName,
			peerAgentAddress: pendingConnect.peerAgentAddress,
			permissions: existingContact?.permissions ?? createEmptyPermissionState(establishedAt),
			establishedAt: existingContact?.establishedAt ?? establishedAt,
			lastContactAt: establishedAt,
			status: "active",
		};

		if (existingContact) {
			await this.context.trustStore.updateContact(existingContact.connectionId, nextContact);
		} else {
			await this.context.trustStore.addContact(nextContact);
		}
		await this.pendingConnectStore.delete(result.requestId);
		this.log(
			"info",
			`Connection accepted by ${pendingConnect.peerDisplayName} (#${pendingConnect.peerAgentId})`,
		);
		return "received";
	}

	private async handleActionResult(
		from: number,
		message: ProtocolMessage,
	): Promise<string | undefined> {
		const contact = await findContactForMessage(this.context, from, message);
		if (contact) {
			await this.appendConversationLogSafe(contact, message, "incoming");
			await this.touchContactSafe(contact.connectionId);
		}

		const response = parseTransferActionResponse(message);
		if (response) {
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
				await this.context.requestJournal.updateMetadata(
					response.requestId,
					serializeRecordedTransferResponse(response),
				);
				await this.context.requestJournal.updateStatus(response.requestId, "completed");
				this.waiters.get(response.requestId)?.(response);
			}
			if (contact) {
				this.log(
					"info",
					`Received transfer ${response.status} result from ${contact.peerDisplayName} (#${contact.peerAgentId})`,
				);
			}
			return contact?.peerDisplayName;
		}

		const schedulingResponse = parseSchedulingActionResponse(message);
		if (schedulingResponse) {
			const requestId = (message.params as { requestId?: string } | undefined)?.requestId;
			if (schedulingResponse.type === "scheduling/accept" && this.schedulingHandler) {
				let title = "Meeting";
				let originTimezone = "UTC";
				if (requestId) {
					const originalRequest = await this.context.requestJournal.getByRequestId(requestId);
					const originalProposal = parseStoredSchedulingRequest(originalRequest?.metadata);
					if (originalProposal) {
						title = originalProposal.title;
						originTimezone = originalProposal.originTimezone;
					}
				}
				await this.schedulingHandler.handleAccept(
					schedulingResponse,
					contact?.peerDisplayName ?? "Unknown",
					title,
					originTimezone,
				);
			}

			if (requestId) {
				await this.context.requestJournal.updateStatus(requestId, "completed");
			}

			if (contact) {
				const eventType = schedulingResponse.type.split("/")[1] ?? schedulingResponse.type;
				await this.appendLedger({
					peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
					direction: "local",
					event: `scheduling-${eventType}`,
					scope: "scheduling/request",
					action_id: schedulingResponse.schedulingId,
					decision: eventType,
				});
				this.log(
					"info",
					`Received scheduling ${eventType} result from ${contact.peerDisplayName} (#${contact.peerAgentId})`,
				);
			}
			return contact?.peerDisplayName;
		}

		return contact?.peerDisplayName;
	}

	private async sendConnectionResult(
		peer: ResolvedAgent,
		result: ConnectionResultParams,
	): Promise<void> {
		const delivery = buildPendingConnectionResultDelivery(peer, result);
		const deliveryRequestId = String(delivery.request.id);
		let persisted = false;
		try {
			await this.context.requestJournal.putOutbound({
				requestId: deliveryRequestId,
				requestKey: `outbound:${delivery.request.method}:${deliveryRequestId}`,
				direction: "outbound",
				kind: "result",
				method: delivery.request.method,
				peerAgentId: peer.agentId,
				correlationId: result.requestId,
				status: "pending",
				metadata: serializePendingConnectionResultDelivery(delivery),
			});
			persisted = true;
		} catch (error: unknown) {
			this.log(
				"error",
				`Failed to persist retry metadata for connection result ${result.requestId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		try {
			if (persisted) {
				await this.deliverPendingConnectionResult(delivery);
			} else {
				await this.context.transport.send(delivery.peerAgentId, delivery.request, {
					peerAddress: delivery.peerAddress,
					timeout: OUTBOUND_RESULT_RECEIPT_TIMEOUT_MS,
				});
			}
		} catch (error: unknown) {
			this.logResultDeliveryFailure(
				"Connection result",
				`${peer.registrationFile.name} (#${peer.agentId})`,
				error,
			);
		}
	}

	private async decideTransfer(
		requestId: string,
		contact: Contact,
		request: TransferActionRequest,
	): Promise<boolean | null> {
		const transferGrants = findApplicableTransferGrants(contact.permissions.grantedByMe, request);
		const override = this.decisionOverrides.transfers.get(requestId);
		if (override === false) {
			return false;
		}
		if (override === true) {
			return true;
		}

		if (transferGrants.length === 0) {
			if (this.hooks.approveTransfer) {
				return (
					(await this.hooks.approveTransfer({
						requestId,
						contact,
						request,
						activeTransferGrants: transferGrants,
						ledgerPath: getPermissionLedgerPath(this.context.config.dataDir),
					})) ?? null
				);
			}
			this.log(
				"warn",
				`Rejecting action request ${request.actionId} from ${contact.peerDisplayName} (#${contact.peerAgentId}) because no matching active transfer grant exists`,
			);
			return false;
		}

		if (!this.hooks.approveTransfer) {
			return true; // Covered by grant — no hook needed to confirm
		}
		return (
			(await this.hooks.approveTransfer({
				requestId,
				contact,
				request,
				activeTransferGrants: transferGrants,
				ledgerPath: getPermissionLedgerPath(this.context.config.dataDir),
			})) ?? null
		);
	}

	private async retryPendingActionResults(): Promise<number> {
		const pending = await this.context.requestJournal.listPending("outbound");
		let processed = 0;
		for (const entry of pending) {
			if (entry.kind !== "result" || entry.method !== ACTION_RESULT) {
				continue;
			}
			const delivery = parsePendingActionResultDelivery(entry.metadata);
			if (!delivery) {
				continue;
			}
			try {
				await this.deliverPendingActionResult(delivery);
				processed += 1;
			} catch (error: unknown) {
				this.logResultDeliveryFailure(
					`Action result ${delivery.actionId}`,
					`${delivery.peerName} (#${delivery.peerAgentId})`,
					error,
				);
			}
		}
		return processed;
	}

	private async retryPendingConnectionRequests(): Promise<number> {
		const pending = await this.context.requestJournal.listPending("inbound");
		let processed = 0;
		for (const entry of pending) {
			if (entry.kind !== "request" || entry.method !== CONNECTION_REQUEST) {
				continue;
			}
			const pendingRequest = parsePendingConnectionRequest(entry.metadata);
			if (!pendingRequest || this.inFlightKeys.has(entry.requestKey)) {
				continue;
			}
			try {
				const result = await this.processConnectionRequest(pendingRequest.message);
				if (result === "processed") {
					await this.context.requestJournal.updateStatus(entry.requestId, "completed");
					processed += 1;
				}
			} catch (error: unknown) {
				this.log(
					"warn",
					`Failed to retry connection request ${entry.requestId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return processed;
	}

	private async retryPendingConnectionResults(): Promise<number> {
		const pending = await this.context.requestJournal.listPending("outbound");
		let processed = 0;
		for (const entry of pending) {
			if (entry.kind !== "result" || entry.method !== CONNECTION_RESULT) {
				continue;
			}
			const delivery = parsePendingConnectionResultDelivery(entry.metadata);
			if (!delivery) {
				continue;
			}
			try {
				await this.deliverPendingConnectionResult(delivery);
				processed += 1;
			} catch (error: unknown) {
				this.logResultDeliveryFailure(
					"Connection result",
					`${delivery.peerName} (#${delivery.peerAgentId})`,
					error,
				);
			}
		}
		return processed;
	}

	private async deliverPendingActionResult(delivery: PendingActionResultDelivery): Promise<void> {
		await this.context.transport.send(delivery.peerAgentId, delivery.request, {
			peerAddress: delivery.peerAddress,
			timeout: OUTBOUND_RESULT_RECEIPT_TIMEOUT_MS,
		});
		await this.context.requestJournal.updateStatus(String(delivery.request.id), "completed");
		await this.context.requestJournal.updateMetadata(String(delivery.request.id), undefined);

		const contact = await this.context.trustStore.getContact(delivery.connectionId);
		if (!contact || contact.peerAgentId !== delivery.peerAgentId) {
			return;
		}
		await this.appendConversationLogSafe(contact, delivery.request, "outgoing");
		await this.touchContactSafe(contact.connectionId);
	}

	private async deliverPendingConnectionResult(
		delivery: PendingConnectionResultDelivery,
	): Promise<void> {
		await this.context.transport.send(delivery.peerAgentId, delivery.request, {
			peerAddress: delivery.peerAddress,
			timeout: OUTBOUND_RESULT_RECEIPT_TIMEOUT_MS,
		});
		await this.context.requestJournal.updateStatus(String(delivery.request.id), "completed");
		await this.context.requestJournal.updateMetadata(String(delivery.request.id), undefined);
	}

	private logActionResultDeliveryFailure(contact: Contact, actionId: string, error: unknown): void {
		this.logResultDeliveryFailure(
			`Action result ${actionId}`,
			`${contact.peerDisplayName} (#${contact.peerAgentId})`,
			error,
		);
	}

	private logResultDeliveryFailure(subject: string, peerLabel: string, error: unknown): void {
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (isTransportReceiptTimeout(error)) {
			this.log(
				"warn",
				`${subject} to ${peerLabel} timed out waiting for a delivery receipt; the peer may still receive it during a later sync (${errorMessage})`,
			);
			return;
		}

		this.log(
			"error",
			`Failed to deliver ${subject.toLowerCase()} to ${peerLabel}: ${errorMessage}`,
		);
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
		typeof params.invite !== "object" ||
		params.invite === null ||
		typeof params.invite.agentId !== "number" ||
		typeof params.invite.chain !== "string" ||
		typeof params.invite.expires !== "number" ||
		typeof params.invite.signature !== "string" ||
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
		typeof params.from?.agentId !== "number" ||
		typeof params.from.chain !== "string" ||
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
		typeof params.grantor?.agentId !== "number" ||
		typeof params.grantor.chain !== "string" ||
		typeof params.grantee?.agentId !== "number" ||
		typeof params.grantee.chain !== "string" ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid grant publication payload");
	}

	return {
		grantSet: normalizeGrantInput(params.grantSet),
		grantor: params.grantor,
		grantee: params.grantee,
		note: typeof params.note === "string" && params.note.length > 0 ? params.note : undefined,
		timestamp: params.timestamp,
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
	if (!metadata) {
		return undefined;
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

	if (metadata.type === "scheduling") {
		return {
			type: "scheduling",
			peerName: asString(metadata.peerName) ?? "Unknown peer",
			peerChain: asString(metadata.peerChain) ?? "unknown",
			schedulingId: asString(metadata.schedulingId) ?? "",
			title: asString(metadata.title) ?? "",
			duration: typeof metadata.duration === "number" ? metadata.duration : 0,
			slots: Array.isArray(metadata.slots)
				? (metadata.slots as Array<{ start: string; end: string }>)
				: [],
			originTimezone: asString(metadata.originTimezone) ?? "UTC",
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

function serializePendingTransferRequestDetails(
	contact: Contact,
	request: TransferActionRequest,
	dataDir: string,
): Record<string, unknown> {
	return {
		...serializePendingRequestDetails(buildPendingTransferDetails(contact, request, dataDir)),
		request: {
			type: "transfer-request",
			payload: request,
		},
	};
}

function serializePendingSchedulingRequestDetails(
	contact: Contact,
	request: SchedulingProposal,
	dataDir: string,
): Record<string, unknown> {
	const grants = findApplicableSchedulingGrants(contact.permissions.grantedByMe, request);
	const details: TapPendingSchedulingDetails = {
		type: "scheduling",
		peerName: contact.peerDisplayName,
		peerChain: contact.peerChain,
		schedulingId: request.schedulingId,
		title: request.title,
		duration: request.duration,
		slots: request.slots,
		originTimezone: request.originTimezone,
		note: request.note,
		activeGrantSummary: grants.map((g) => summarizeGrant(g)),
		ledgerPath: getPermissionLedgerPath(dataDir),
	};
	return {
		...serializePendingRequestDetails(details),
		request: {
			type: "scheduling-request",
			payload: request,
		},
	};
}

function serializePendingSchedulingOutboundRequestDetails(
	contact: Contact,
	request: SchedulingProposal,
	dataDir: string,
): Record<string, unknown> {
	const details: TapPendingSchedulingDetails = {
		type: "scheduling",
		peerName: contact.peerDisplayName,
		peerChain: contact.peerChain,
		schedulingId: request.schedulingId,
		title: request.title,
		duration: request.duration,
		slots: request.slots,
		originTimezone: request.originTimezone,
		note: request.note,
		activeGrantSummary: findActiveGrantsByScope(
			contact.permissions.grantedByPeer,
			"scheduling/request",
		).map((grant) => summarizeGrant(grant)),
		ledgerPath: getPermissionLedgerPath(dataDir),
	};
	return {
		...serializePendingRequestDetails(details),
		request: {
			type: "scheduling-request",
			payload: request,
		},
	};
}

function parseStoredSchedulingRequest(
	metadata: Record<string, unknown> | undefined,
): SchedulingProposal | null {
	const payload = parseStoredRequestField(metadata, "scheduling-request", "payload");
	if (payload === null) {
		return null;
	}

	return parseSchedulingActionRequest({
		jsonrpc: "2.0",
		id: "pending-scheduling-request",
		method: ACTION_REQUEST,
		params: {
			message: {
				parts: [{ kind: "data", data: payload }],
			},
		},
	});
}

function buildPendingActionResultDelivery(
	contact: Contact,
	requestId: string,
	response: TransferActionResponse,
): PendingActionResultDelivery {
	const request = buildOutgoingActionResult(
		contact,
		requestId,
		buildTransferResponseText(response),
		response,
		"transfer/request",
		response.status,
	);
	return {
		type: "action-result-delivery",
		actionId: response.actionId,
		connectionId: contact.connectionId,
		peerAgentId: contact.peerAgentId,
		peerName: contact.peerDisplayName,
		peerAddress: contact.peerAgentAddress,
		request,
	};
}

function serializePendingActionResultDelivery(
	delivery: PendingActionResultDelivery,
): Record<string, unknown> {
	return delivery as unknown as Record<string, unknown>;
}

function serializePendingConnectionRequest(message: ProtocolMessage): Record<string, unknown> {
	return {
		type: "connection-request",
		message,
	};
}

function buildPendingConnectionResultDelivery(
	peer: ResolvedAgent,
	result: ConnectionResultParams,
): PendingConnectionResultDelivery {
	const request = buildConnectionResult(result);
	return {
		type: "connection-result-delivery",
		peerAgentId: peer.agentId,
		peerName: peer.registrationFile.name,
		peerAddress: peer.xmtpEndpoint ?? peer.agentAddress,
		request,
	};
}

function serializePendingConnectionResultDelivery(
	delivery: PendingConnectionResultDelivery,
): Record<string, unknown> {
	return delivery as unknown as Record<string, unknown>;
}

function parsePendingConnectionResultDelivery(
	metadata: Record<string, unknown> | undefined,
): PendingConnectionResultDelivery | null {
	if (!metadata || metadata.type !== "connection-result-delivery") {
		return null;
	}

	const peerAddress = asString(metadata.peerAddress);
	if (
		typeof metadata.peerAgentId !== "number" ||
		typeof metadata.peerName !== "string" ||
		!peerAddress?.startsWith("0x") ||
		!isProtocolMessage(metadata.request)
	) {
		return null;
	}

	return {
		type: "connection-result-delivery",
		peerAgentId: metadata.peerAgentId,
		peerName: metadata.peerName,
		peerAddress: peerAddress as `0x${string}`,
		request: metadata.request,
	};
}

function parsePendingConnectionRequest(
	metadata: Record<string, unknown> | undefined,
): PendingConnectionRequest | null {
	if (!metadata || metadata.type !== "connection-request" || !isProtocolMessage(metadata.message)) {
		return null;
	}

	return {
		type: "connection-request",
		message: metadata.message,
	};
}

function parsePendingActionResultDelivery(
	metadata: Record<string, unknown> | undefined,
): PendingActionResultDelivery | null {
	if (!metadata || metadata.type !== "action-result-delivery") {
		return null;
	}

	const peerAddress = asString(metadata.peerAddress);
	if (
		typeof metadata.actionId !== "string" ||
		typeof metadata.connectionId !== "string" ||
		typeof metadata.peerAgentId !== "number" ||
		typeof metadata.peerName !== "string" ||
		!peerAddress?.startsWith("0x") ||
		!isProtocolMessage(metadata.request)
	) {
		return null;
	}

	return {
		type: "action-result-delivery",
		actionId: metadata.actionId,
		connectionId: metadata.connectionId,
		peerAgentId: metadata.peerAgentId,
		peerName: metadata.peerName,
		peerAddress: peerAddress as `0x${string}`,
		request: metadata.request,
	};
}

function parseStoredTransferRequest(
	metadata: Record<string, unknown> | undefined,
): TransferActionRequest | null {
	const payload = parseStoredRequestField(metadata, "transfer-request", "payload");
	if (payload === null) {
		return null;
	}

	return parseTransferActionRequest({
		jsonrpc: "2.0",
		id: "pending-transfer-request",
		method: ACTION_REQUEST,
		params: {
			message: {
				parts: [{ kind: "data", data: payload }],
			},
		},
	});
}

function parseStoredRequestField(
	metadata: Record<string, unknown> | undefined,
	expectedType: string,
	field: string,
): unknown | null {
	if (!metadata) {
		return null;
	}

	const request = metadata.request;
	if (typeof request !== "object" || request === null) {
		return null;
	}
	if ((request as { type?: unknown }).type !== expectedType) {
		return null;
	}

	return (request as Record<string, unknown>)[field] ?? null;
}

function resolvePermissionsUpdatePeer(
	config: Pick<TrustedAgentsConfig, "agentId" | "chain">,
	params: Pick<PermissionsUpdateParams, "grantor" | "grantee">,
) {
	const localAgent = { agentId: config.agentId, chain: config.chain };
	const grantorIsLocal = isSameAgentIdentifier(params.grantor, localAgent);
	const granteeIsLocal = isSameAgentIdentifier(params.grantee, localAgent);

	if (grantorIsLocal === granteeIsLocal) {
		throw new ValidationError("Grant update must involve the local agent exactly once");
	}

	return grantorIsLocal ? params.grantee : params.grantor;
}

function serializeRecordedTransferResponse(
	response: TransferActionResponse,
): RecordedTransferResponseMetadata {
	return {
		type: "transfer-response",
		response,
	};
}

function parseRecordedTransferResponse(
	metadata: Record<string, unknown> | undefined,
): TransferActionResponse | null {
	if (!metadata || metadata.type !== "transfer-response") {
		return null;
	}

	const response = metadata.response;
	if (typeof response !== "object" || response === null) {
		return null;
	}

	const parsed = response as Partial<TransferActionResponse>;
	if (
		parsed.type !== "transfer/response" ||
		typeof parsed.actionId !== "string" ||
		(parsed.asset !== "native" && parsed.asset !== "usdc") ||
		typeof parsed.amount !== "string" ||
		typeof parsed.chain !== "string" ||
		typeof parsed.toAddress !== "string" ||
		(parsed.status !== "completed" && parsed.status !== "rejected" && parsed.status !== "failed")
	) {
		return null;
	}

	return parsed as TransferActionResponse;
}

function isProtocolMessage(value: unknown): value is ProtocolMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
		typeof (value as { method?: unknown }).method === "string" &&
		"id" in (value as Record<string, unknown>)
	);
}

function isSameAgentIdentifier(
	left: Pick<AgentIdentifier, "agentId" | "chain">,
	right: Pick<AgentIdentifier, "agentId" | "chain">,
): boolean {
	return left.agentId === right.agentId && left.chain === right.chain;
}

function findApplicableTransferGrants(
	grantSet: PermissionGrantSet,
	request: TransferActionRequest,
) {
	return findActiveGrantsByScope(grantSet, "transfer/request").filter((grant) =>
		matchesTransferGrantRequest(grant, request),
	);
}

function matchesTransferGrantRequest(
	grant: PermissionGrantSet["grants"][number],
	request: TransferActionRequest,
): boolean {
	const constraints = grant.constraints;
	if (!constraints) {
		return true;
	}

	if (typeof constraints.asset === "string" && constraints.asset !== request.asset) {
		return false;
	}

	if (typeof constraints.chain === "string" && constraints.chain !== request.chain) {
		return false;
	}

	if (
		typeof constraints.toAddress === "string" &&
		constraints.toAddress.toLowerCase() !== request.toAddress.toLowerCase()
	) {
		return false;
	}

	if (typeof constraints.maxAmount === "string") {
		try {
			const maxAmount =
				request.asset === "native"
					? parseEther(constraints.maxAmount)
					: parseUnits(constraints.maxAmount, getUsdcAsset(request.chain)?.decimals ?? 6);
			const requestedAmount =
				request.asset === "native"
					? parseEther(request.amount)
					: parseUnits(request.amount, getUsdcAsset(request.chain)?.decimals ?? 6);
			if (requestedAmount > maxAmount) {
				return false;
			}
		} catch {
			return false;
		}
	}

	return true;
}

function isTransportReceiptTimeout(error: unknown): error is TransportError {
	return (
		error instanceof TransportError && error.message.startsWith("Response timeout for message ")
	);
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
		const peer = resolvePermissionsUpdatePeer(context.config, params);
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

function assertNever(value: never): never {
	throw new ValidationError(`Unsupported queued TAP job type: ${String(value)}`);
}

export { TransportOwnershipError };
