import { parseEther, parseUnits } from "viem";
import { buildActionContext } from "../app/context.js";
import type { TapActionContext, TapActionResult } from "../app/types.js";
import { defineTapApp } from "../app/types.js";
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
	toErrorMessage,
} from "../common/index.js";
import type { TrustedAgentsConfig } from "../config/types.js";
import {
	buildConnectionRequest,
	buildConnectionResult,
	buildPermissionsUpdate,
	deriveConnectionResultId,
	handleConnectionRequest,
	isSelfInvite,
	parseInviteUrl,
	verifyInvite,
} from "../connection/index.js";
import type { ResolvedAgent } from "../identity/types.js";
import { createEmptyPermissionState, createGrantSet } from "../permissions/index.js";
import type { PermissionGrantSet } from "../permissions/types.js";
import { extractConnectionIdFromParams } from "../protocol/messages.js";
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
	MessageSendParams,
	PermissionsUpdateParams,
	TextPart,
} from "../protocol/types.js";
import {
	buildSchedulingAcceptText,
	buildSchedulingProposalText,
	buildSchedulingRejectText,
	parseSchedulingActionRequest,
	parseSchedulingActionResponse,
} from "../scheduling/actions.js";
import {
	findApplicableSchedulingGrants,
	findSchedulableSchedulingSlots,
} from "../scheduling/grants.js";
import {
	type ConfirmedMeeting,
	type ProposedMeeting,
	type SchedulingApprovalContext,
	type SchedulingHandler,
	mapSchedulingDecisionToResult,
} from "../scheduling/handler.js";
import type { SchedulingProposal } from "../scheduling/types.js";
import type { SigningProvider } from "../signing/provider.js";
import type { ProtocolMessage } from "../transport/interface.js";
import type {
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "../transport/interface.js";
import { peerLabel } from "../trust/types.js";
import type { Contact } from "../trust/types.js";
import {
	type PermissionGrantRequestAction,
	type TransferActionRequest,
	type TransferActionResponse,
	buildPermissionGrantRequestText,
	buildTransferRequestText,
	buildTransferResponseText,
	extractMessageData,
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
/**
 * Pending outbound result entries older than this are garbage-collected by the
 * retry pipeline. Prevents accumulation when a peer is permanently unreachable
 * (or when the local side has lost track of outbound deliveries across many
 * restarts).
 */
const PENDING_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
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
	/**
	 * CAIP-2 chain id of the target peer. Used so implicit handshake
	 * completion and the short-circuit cache can scope matches per-chain —
	 * two peers on different chains can share the same numeric agentId.
	 *
	 * Optional for backward compatibility with journal entries written by
	 * versions before this field was introduced. Legacy entries are still
	 * delivered via the direct retry pipeline (which only needs peerAgentId
	 * + peerAddress); they just can't participate in the chain-scoped
	 * implicit-completion short-circuit.
	 */
	peerChain?: string;
	peerName: string;
	peerAddress: `0x${string}`;
	request: ProtocolMessage;
}

const DELIVERY_FAILURE_METADATA_KEY = "__deliveryFailure";

interface DeliveryFailureMetadata {
	type: "delivery-failure";
	attempts: number;
	lastAttemptAt: string;
	lastError: string;
}

interface PendingConnectionRequest extends Record<string, unknown> {
	type: "connection-request";
	message: ProtocolMessage;
}

interface RecordedTransferResponseMetadata extends Record<string, unknown> {
	type: "transfer-response";
	response: TransferActionResponse;
}

type SchedulingRequestState = "accepted" | "cancelled" | "rejected";

interface SchedulingTrackingMetadata extends Record<string, unknown> {
	localEventId?: string;
	schedulingState?: SchedulingRequestState;
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

export interface TapPendingDelivery {
	requestId: string;
	method: string;
	peerAgentId: number;
	correlationId?: string;
	ageMs: number;
	attempts?: number;
	lastAttemptAt?: string;
	lastError?: string;
}

export interface TapSyncReport {
	synced: true;
	processed: number;
	pendingRequests: TapServiceStatus["pendingRequests"];
	pendingDeliveries: TapPendingDelivery[];
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

export interface TapCancelMeetingResult {
	requestId: string;
	peerAgentId: number;
	schedulingId: string;
	report: TapSyncReport;
}

export class TapMessagingService {
	private readonly context: TapRuntimeContext;
	private readonly hooks: TapServiceHooks;
	private readonly ownerLabel: string;
	private readonly signingProvider: SigningProvider;
	private readonly ownerLock: TransportOwnerLock;
	private readonly pendingConnectStore: FilePendingConnectStore;
	private localAgentAddress: `0x${string}` | undefined;
	private readonly executionMutex = new AsyncMutex();
	private readonly commandOutbox: FileTapCommandOutbox;
	private readonly outboxPollIntervalMs: number;
	private readonly outboxResultRetentionMs: number;
	private readonly outboxStaleLeaseMs: number;
	private readonly pendingTasks = new Set<Promise<void>>();
	private readonly inFlightKeys = new Set<string>();
	/**
	 * Peers that currently have (or recently had) a pending outbound
	 * connection/result entry in the journal. Lets the implicit-completion
	 * path avoid a full journal scan on every inbound DM. See
	 * {@link markPendingConnectionResultsCompletedFor}.
	 *
	 * Keyed by {@link peerConnectionResultCacheKey} = `"chain:agentId"` so
	 * two peers that happen to share a numeric agentId across chains do not
	 * collide. Cache is authoritative as a "yes, scan the journal" hint —
	 * false positives only cost an extra scan, false negatives could orphan
	 * a pending entry from the implicit-completion path. We therefore prefer
	 * stale-positive over stale-negative: the cache is updated only when we
	 * have full certainty that no pending entries remain for the peer.
	 */
	private readonly peersWithPendingConnectionResult = new Set<string>();
	private connectionResultCachePriming: Promise<void> | null = null;
	private connectionResultCachePrimed = false;
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
	private manifestLoaded = false;

	constructor(context: TapRuntimeContext, options: TapServiceOptions = {}) {
		this.context = context;
		this.signingProvider = context.signingProvider;
		this.hooks = options.hooks ?? {};
		this.ownerLabel = options.ownerLabel ?? `tap:${process.pid}`;
		this.ownerLock = new TransportOwnerLock(context.config.dataDir, this.ownerLabel);
		this.pendingConnectStore = new FilePendingConnectStore(context.config.dataDir);
		this.commandOutbox = options.commandOutbox ?? new FileTapCommandOutbox(context.config.dataDir);
		this.outboxPollIntervalMs = options.outboxPollIntervalMs ?? OUTBOX_POLL_INTERVAL_MS;
		this.outboxResultRetentionMs = options.outboxResultRetentionMs ?? OUTBOX_RESULT_RETENTION_MS;
		this.outboxStaleLeaseMs = options.outboxStaleLeaseMs ?? OUTBOX_STALE_LEASE_MS;
		this.schedulingHandler = options.schedulingHandler;
		this.handlers = {
			onRequest: async (envelope) => await this.onRequest(envelope),
			onResult: async (envelope) => await this.onResult(envelope),
		};
		this.registerBuiltinApps();
	}

	/** Load the installed app manifest once so the registry can lazy-load custom apps. */
	private async ensureManifestLoaded(): Promise<void> {
		if (this.manifestLoaded) return;
		await this.context.appRegistry.loadManifest();
		this.manifestLoaded = true;
	}

	private registerBuiltinApps(): void {
		// Register transfer/request as an inline app that delegates to the
		// existing processTransferRequest method.
		this.context.appRegistry.registerApp(
			defineTapApp({
				id: "tap-transfer",
				name: "TAP Transfer",
				version: "0.0.0",
				grantScopes: ["transfer/request"],
				actions: {
					"transfer/request": {
						handler: async (_ctx) => {
							// The actual processing is still done by the existing
							// processTransferRequest method via the dispatch in onRequest.
							// This registration exists so that resolveHandler succeeds and
							// the dispatch does not emit UNSUPPORTED_ACTION.
							// The real handler is never called directly — the dispatch
							// delegates to the legacy codepath.
							return { success: true };
						},
					},
				},
			}),
		);

		// Register scheduling action types as an inline app that delegates to
		// SchedulingHandler for calendar availability and operator approval.
		this.context.appRegistry.registerApp(
			defineTapApp({
				id: "scheduling",
				name: "Scheduling",
				version: "1.0.0",
				grantScopes: ["scheduling/request"],
				actions: {
					"scheduling/propose": {
						handler: async (ctx) => {
							return this.handleSchedulingAction(ctx);
						},
					},
					"scheduling/counter": {
						handler: async (ctx) => {
							return this.handleSchedulingAction(ctx);
						},
					},
				},
			}),
		);

		// Register permission grant request as an inline app.
		this.context.appRegistry.registerApp(
			defineTapApp({
				id: "tap-permissions",
				name: "TAP Permissions",
				version: "0.0.0",
				grantScopes: [],
				actions: {
					"permissions/request-grants": {
						handler: async (_ctx) => {
							return { success: true };
						},
					},
				},
			}),
		);
	}

	private async getLocalAgentAddress(): Promise<`0x${string}`> {
		if (!this.localAgentAddress) {
			this.localAgentAddress = await this.signingProvider.getAddress();
		}
		return this.localAgentAddress;
	}

	get transport(): TransportProvider {
		return this.context.transport;
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		await this.ensureManifestLoaded();

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
		const pending = await this.context.requestJournal.listPending();
		return pending.filter((entry) => entry.kind === "request").map(toPendingRequestView);
	}

	private async findCancellableSchedulingRequest(
		schedulingId: string,
	): Promise<RequestJournalEntry | null> {
		const entries = (await this.context.requestJournal.list())
			.filter((entry) => entry.kind === "request" && entry.method === ACTION_REQUEST)
			.reverse();

		const matchesSchedulingId = (entry: RequestJournalEntry): boolean =>
			parseStoredSchedulingRequest(entry.metadata)?.schedulingId === schedulingId;

		const pendingOutbound = entries.find(
			(entry) =>
				entry.direction === "outbound" &&
				entry.status !== "completed" &&
				matchesSchedulingId(entry),
		);
		if (pendingOutbound) {
			return pendingOutbound;
		}

		return (
			entries.find((entry) => {
				if (!matchesSchedulingId(entry)) {
					return false;
				}
				return parseSchedulingTrackingMetadata(entry.metadata).schedulingState === "accepted";
			}) ?? null
		);
	}

	private async closePendingOutboundSchedulingRequestForCounter(
		peerAgentId: number,
		schedulingId: string,
	): Promise<void> {
		const pendingOutbound = await this.context.requestJournal.listPending("outbound");
		const supersededRequest = pendingOutbound.find(
			(entry) =>
				entry.kind === "request" &&
				entry.method === ACTION_REQUEST &&
				entry.peerAgentId === peerAgentId &&
				parseStoredSchedulingRequest(entry.metadata)?.schedulingId === schedulingId,
		);
		if (!supersededRequest) {
			return;
		}
		await this.context.requestJournal.updateStatus(supersededRequest.requestId, "completed");
	}

	private async updateSchedulingTracking(
		requestId: string,
		updates: SchedulingTrackingMetadata,
	): Promise<void> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		if (!entry) {
			return;
		}
		await this.context.requestJournal.updateMetadata(
			requestId,
			mergeMetadata(entry.metadata, updates),
		);
	}

	private async cancelLocalSchedulingEvent(
		requestId: string,
		localEventId: string | undefined,
		contextLabel: string,
	): Promise<boolean> {
		if (!localEventId || !this.schedulingHandler) {
			return false;
		}
		try {
			await this.schedulingHandler.handleCancel(localEventId);
			return true;
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to cancel local calendar event for scheduling request ${requestId} during ${contextLabel}: ${toErrorMessage(error)}`,
			);
			return false;
		}
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

	async cancelMeeting(schedulingId: string, reason?: string): Promise<TapCancelMeetingResult> {
		const entry = await this.findCancellableSchedulingRequest(schedulingId);
		if (!entry) {
			throw new ValidationError(
				`No pending or accepted meeting found with schedulingId: ${schedulingId}`,
			);
		}

		const report = await this.cancelPendingSchedulingRequest(entry.requestId, reason);
		return {
			requestId: entry.requestId,
			peerAgentId: entry.peerAgentId,
			schedulingId,
			report,
		};
	}

	async cancelPendingSchedulingRequest(requestId: string, reason?: string): Promise<TapSyncReport> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		if (!entry || entry.kind !== "request") {
			throw new ValidationError(`Scheduling request not found: ${requestId}`);
		}
		if (entry.method !== ACTION_REQUEST) {
			throw new ValidationError(`Request ${requestId} cannot be cancelled manually`);
		}

		const tracking = parseSchedulingTrackingMetadata(entry.metadata);
		if (entry.direction !== "outbound" && tracking.schedulingState !== "accepted") {
			throw new ValidationError(`Scheduling request ${requestId} is not cancellable`);
		}

		if (!parseStoredSchedulingRequest(entry.metadata)) {
			throw new ValidationError(
				`Scheduling request ${requestId} is missing the original request payload`,
			);
		}

		return await this.executionMutex.runExclusive(
			async () =>
				await this.withTransportSession(async () => {
					await this.drain();
					const latestEntry = await this.context.requestJournal.getByRequestId(requestId);
					if (!latestEntry || latestEntry.kind !== "request") {
						throw new ValidationError(`Scheduling request not found: ${requestId}`);
					}
					const latestTracking = parseSchedulingTrackingMetadata(latestEntry.metadata);
					const acceptedMeeting = latestTracking.schedulingState === "accepted";
					if (latestEntry.direction !== "outbound" && !acceptedMeeting) {
						throw new ValidationError(`Scheduling request ${requestId} is not cancellable`);
					}
					if (latestEntry.status === "completed" && !acceptedMeeting) {
						throw new ValidationError(`Scheduling request ${requestId} is not pending or accepted`);
					}

					const latestProposal = parseStoredSchedulingRequest(latestEntry.metadata);
					if (!latestProposal) {
						throw new ValidationError(
							`Scheduling request ${requestId} is missing the original request payload`,
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
						waitForAck: false,
					});
					await this.appendConversationLogSafe(contact, outgoing, "outgoing");
					const clearedLocalEvent = await this.cancelLocalSchedulingEvent(
						latestEntry.requestId,
						latestTracking.localEventId,
						`local cancellation for ${latestProposal.schedulingId}`,
					);

					await this.updateSchedulingTracking(latestEntry.requestId, {
						schedulingState: "cancelled",
						...(clearedLocalEvent ? { localEventId: undefined } : {}),
					});

					await this.context.requestJournal.updateStatus(requestId, "completed");
					await this.appendLedger({
						peer: peerLabel(contact),
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
		options?: { autoGenerated?: boolean },
	): Promise<TapSendMessageResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.sendMessageInternal(peer, text, scope, options),
		);
	}

	private async sendMessageInternal(
		peer: string,
		text: string,
		scope = DEFAULT_MESSAGE_SCOPE,
		options?: { autoGenerated?: boolean },
	): Promise<TapSendMessageResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(peer);
			const request = buildOutgoingMessageRequest(contact, text, scope, options);
			const timestamp = nowISO();
			// Fire-and-forget: a one-shot peer that isn't running `tap message
			// listen` during the publish window would otherwise turn a
			// successful XMTP publication into a local timeout.
			const receipt = await this.context.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
				waitForAck: false,
			});

			await this.appendConversationLogSafe(contact, request, "outgoing", timestamp);

			return {
				receipt,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				scope,
			};
		});
	}

	async sendActionRequest(
		peer: { agentId: number } | { connectionId: string },
		actionType: string,
		payload: Record<string, unknown>,
		text?: string,
	): Promise<TapSendMessageResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.sendActionRequestInternal(peer, actionType, payload, text),
		);
	}

	private async sendActionRequestInternal(
		peer: { agentId: number } | { connectionId: string },
		actionType: string,
		payload: Record<string, unknown>,
		text?: string,
	): Promise<TapSendMessageResult> {
		return await this.withTransportSession(async () => {
			let contact: Contact;
			if ("connectionId" in peer) {
				const c = await this.context.trustStore.getContact(peer.connectionId);
				if (!c || c.status !== "active") {
					throw new ValidationError(`No active contact found for connection ${peer.connectionId}`);
				}
				contact = c;
			} else {
				const contacts = await this.context.trustStore.getContacts();
				const c = findUniqueContactForAgentId(contacts, peer.agentId);
				if (!c || c.status !== "active") {
					throw new ValidationError(`No active contact found for agent ${peer.agentId}`);
				}
				contact = c;
			}

			const data = { ...payload, type: actionType };
			const scope = actionType;
			const request = buildOutgoingActionRequest(
				contact,
				text ?? `Action request: ${actionType}`,
				data,
				scope,
			);
			const requestId = String(request.id);
			const timestamp = nowISO();

			const receipt = await this.sendAndJournalOutboundRequest(
				contact,
				request,
				requestId,
				timestamp,
				{ actionType },
			);

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
				peer: peerLabel(contact),
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
			await this.appendConversationLogSafe(contact, request, "outgoing", timestamp);

			await this.appendLedger({
				peer: peerLabel(contact),
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
				peer: peerLabel(contact),
				direction: "local",
				event: "transfer-request-sent",
				scope: "transfer/request",
				asset: input.asset,
				amount: input.amount,
				action_id: requestPayload.actionId,
				note: input.note,
			});

			const waiter = this.registerActionResultWaiter(
				requestId,
				requestPayload.actionId,
				ACTION_RESULT_WAIT_TIMEOUT_MS,
			);

			const receipt = await this.sendAndJournalOutboundRequest(
				contact,
				request,
				requestId,
				timestamp,
				undefined,
				() => waiter.cancel(),
			);

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
				peer: peerLabel(contact),
				direction: "local",
				event: "scheduling-request-sent",
				scope: "scheduling/request",
				action_id: proposal.schedulingId,
				note: proposal.note ?? `Meeting: ${proposal.title}`,
			});

			const receipt = await this.sendAndJournalOutboundRequest(
				contact,
				request,
				requestId,
				timestamp,
				serializePendingSchedulingRequestDetails(
					contact,
					proposal,
					this.context.config.dataDir,
					"outbound",
				),
			);

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
				const message = toErrorMessage(error);
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
					job.payload.autoGenerated ? { autoGenerated: true } : undefined,
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
			this.log("warn", `Queued TAP command polling failed: ${toErrorMessage(error)}`);
		} finally {
			this.outboxPollInFlight = false;
		}
	}

	private async withTransportSession<T>(task: () => Promise<T>): Promise<T> {
		if (this.running || this.transportSessionReentryDepth > 0) {
			return await task();
		}

		await this.ensureManifestLoaded();
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
		// Single journal scan partitioned into the two views the report needs.
		// Avoids reading request-journal.json twice per sync.
		const allPending = await this.context.requestJournal.listPending();
		const pendingRequests = allPending
			.filter((entry) => entry.kind === "request")
			.map(toPendingRequestView);
		const pendingDeliveries = allPending
			.filter((entry) => entry.direction === "outbound" && entry.kind === "result")
			.map((entry) => toPendingDeliveryView(entry, Date.now()));
		return {
			synced: true,
			processed,
			pendingRequests,
			pendingDeliveries,
		};
	}

	/**
	 * Pending outbound "result" deliveries — connection/result, action/result,
	 * scheduling responses — whose publication has failed or not yet been
	 * attempted. Surfaces the retry pipeline's backlog so operators and host
	 * agents see real stuck work, not a misleading "processed: 0".
	 */
	async listPendingDeliveries(): Promise<TapPendingDelivery[]> {
		const pending = await this.context.requestJournal.listPending("outbound");
		const now = Date.now();
		return pending
			.filter((entry) => entry.kind === "result")
			.map((entry) => toPendingDeliveryView(entry, now));
	}

	private emitEvent(payload: Record<string, unknown>): void {
		try {
			this.hooks.emitEvent?.({
				timestamp: nowISO(),
				...payload,
			});
		} catch (error: unknown) {
			this.log("warn", `emitEvent hook threw: ${toErrorMessage(error)}`);
		}
	}

	private emitIncomingAndReturn<S extends string>(
		envelope: { from: number; message: ProtocolMessage },
		status: S,
		extra?: Record<string, unknown>,
	): { status: S } {
		this.emitEvent({
			direction: "incoming",
			from: envelope.from,
			method: envelope.message.method,
			id: envelope.message.id,
			receipt_status: status,
			...extra,
		});
		return { status };
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

	private async sendAndJournalOutboundRequest(
		contact: Contact,
		request: ProtocolMessage,
		requestId: string,
		timestamp: string,
		metadata?: Record<string, unknown>,
		onSendError?: () => void,
	): Promise<TransportReceipt> {
		await this.context.requestJournal.putOutbound({
			requestId,
			requestKey: `outbound:${request.method}:${requestId}`,
			direction: "outbound",
			kind: "request",
			method: request.method,
			peerAgentId: contact.peerAgentId,
			status: "pending",
			...(metadata ? { metadata } : {}),
		});

		let receipt: TransportReceipt;
		try {
			receipt = await this.context.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
			});
		} catch (error: unknown) {
			onSendError?.();
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

		return receipt;
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
				`Failed to record conversation log for ${peerLabel(contact)}: ${toErrorMessage(error)}`,
			);
		}
		try {
			await this.context.trustStore.touchContact(contact.connectionId);
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to update contact activity for ${contact.connectionId}: ${toErrorMessage(error)}`,
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
				this.log("error", toErrorMessage(error));
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
				return this.emitIncomingAndReturn(envelope, "duplicate");
			}

			this.enqueue(requestKey, async () => {
				const result = await this.processConnectionRequest(envelope.message);
				if (result === "processed") {
					await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
				}
			});
			return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "queued");
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
			return this.emitIncomingAndReturn(envelope, "duplicate");
		}

		const contact = await findContactForMessage(this.context, envelope.from, envelope.message);
		if (!contact) {
			throw new ValidationError(`No contact found for agent ${envelope.from}`);
		}

		// Implicit handshake completion: the peer could only be sending us a
		// non-bootstrap request if they already have an active contact for us,
		// which means they received our connection/result. Any pending outbound
		// connection/result entries for this peer are now load-bearing no more.
		if (contact.status === "active") {
			await this.markPendingConnectionResultsCompletedFor(contact.peerAgentId, contact.peerChain);
		}

		if (envelope.message.method === PERMISSIONS_UPDATE) {
			await this.handlePermissionsUpdate(contact, envelope.message);
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
			return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "received", {
				fromName: contact.peerDisplayName,
			});
		}

		await this.appendConversationLogSafe(contact, envelope.message, "incoming");

		if (envelope.message.method === MESSAGE_SEND) {
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");

			// Extract message text and autoGenerated flag for emitEvent
			let messageText = "";
			let autoGenerated = false;
			try {
				const params = envelope.message.params as MessageSendParams | undefined;
				if (params?.message?.parts) {
					messageText = params.message.parts
						.filter((p): p is TextPart => p.kind === "text")
						.map((p) => p.text)
						.join("\n");
				}
				autoGenerated = params?.message?.metadata?.trustedAgent?.autoGenerated === true;
			} catch {
				// Defensive: don't fail message processing if extraction fails
			}

			return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "received", {
				fromName: contact.peerDisplayName,
				messageText,
				autoGenerated,
			});
		}

		if (envelope.message.method !== ACTION_REQUEST) {
			throw new ValidationError(`Unsupported request method: ${envelope.message.method}`);
		}

		// Extract the action type from the data payload
		const actionData = extractMessageData(envelope.message);
		const actionType = typeof actionData?.type === "string" ? actionData.type : undefined;

		// Route through the app registry to determine if a handler exists
		const resolved = actionType
			? await this.context.appRegistry.resolveHandler(actionType)
			: undefined;

		if (!resolved) {
			// No handler registered — send an error result back
			await this.sendUnsupportedActionResult(
				contact,
				String(envelope.message.id),
				actionType ?? "unknown",
				requestKey,
			);
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
			return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "received", {
				fromName: contact.peerDisplayName,
				error: "UNSUPPORTED_ACTION",
				actionType: actionType ?? "unknown",
			});
		}

		// Delegate to built-in handlers that use the existing codepaths.
		// The inline app registrations (tap-transfer, tap-permissions) exist to
		// claim action types in the registry. Their actual processing is still
		// done by the existing methods below. The scheduling app delegates to
		// SchedulingHandler via dispatchToApp.
		if (resolved.app.id === "tap-permissions") {
			const permissionRequest = parsePermissionGrantRequest(envelope.message);
			if (permissionRequest) {
				await this.handlePermissionGrantRequest(contact, permissionRequest);
				await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
				return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "received", {
					fromName: contact.peerDisplayName,
				});
			}
			// Malformed permissions payload — reject instead of falling through
			return this.rejectMalformedPayload(
				contact,
				String(envelope.message.id),
				actionType ?? "permissions/request-grants",
				requestKey,
				claimed.duplicate,
			);
		}

		if (resolved.app.id === "scheduling") {
			const schedulingRequest = parseSchedulingActionRequest(envelope.message);
			if (schedulingRequest) {
				await this.context.requestJournal.updateMetadata(
					String(envelope.message.id),
					serializePendingSchedulingRequestDetails(
						contact,
						schedulingRequest,
						this.context.config.dataDir,
						"inbound",
					),
				);
				if (schedulingRequest.type === "scheduling/counter") {
					await this.closePendingOutboundSchedulingRequestForCounter(
						contact.peerAgentId,
						schedulingRequest.schedulingId,
					);
				}

				this.enqueue(requestKey, async () => {
					await this.processSchedulingRequest(
						contact,
						String(envelope.message.id),
						schedulingRequest,
					);
				});

				return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "queued", {
					fromName: contact.peerDisplayName,
					scope: "scheduling/request",
				});
			}
			// Malformed scheduling payload — reject instead of falling through
			return this.rejectMalformedPayload(
				contact,
				String(envelope.message.id),
				actionType ?? "scheduling/propose",
				requestKey,
				claimed.duplicate,
			);
		}

		if (resolved.app.id === "tap-transfer") {
			const transferRequest = parseTransferActionRequest(envelope.message);
			if (transferRequest) {
				await this.context.requestJournal.updateMetadata(
					String(envelope.message.id),
					serializePendingTransferRequestDetails(
						contact,
						transferRequest,
						this.context.config.dataDir,
					),
				);

				this.enqueue(requestKey, async () => {
					await this.processTransferRequest(contact, String(envelope.message.id), transferRequest);
				});
				return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "queued", {
					fromName: contact.peerDisplayName,
				});
			}
			// Malformed transfer payload — reject instead of falling through
			return this.rejectMalformedPayload(
				contact,
				String(envelope.message.id),
				actionType ?? "transfer/request",
				requestKey,
				claimed.duplicate,
			);
		}

		// For dynamically loaded (non-builtin) apps, use the full app dispatch path
		this.enqueue(requestKey, async () => {
			await this.dispatchToApp(
				contact,
				String(envelope.message.id),
				resolved,
				actionData ?? {},
				requestKey,
			);
		});
		return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "queued", {
			fromName: contact.peerDisplayName,
			scope: actionType,
		});
	}

	private async onResult(envelope: {
		from: number;
		senderInboxId: string;
		message: ProtocolMessage;
	}): Promise<{ status: "received" | "duplicate" }> {
		if (envelope.message.method === CONNECTION_RESULT) {
			const status = await this.handleConnectionResult(envelope.message);
			return this.emitIncomingAndReturn(envelope, status);
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
			return this.emitIncomingAndReturn(envelope, "duplicate");
		}

		let peerName: string | undefined;
		if (envelope.message.method === ACTION_RESULT) {
			// Implicit handshake completion runs inside `handleActionResult`
			// once the contact (and therefore peerChain) is resolved.
			peerName = await this.handleActionResult(envelope.from, envelope.message);
		} else {
			throw new ValidationError(`Unsupported result method: ${envelope.message.method}`);
		}

		await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
		return this.emitIncomingAndReturn(
			envelope,
			claimed.duplicate ? "duplicate" : "received",
			peerName ? { fromName: peerName } : undefined,
		);
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
			expectedSignerAddress: await this.getLocalAgentAddress(),
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
			peer: peerLabel(contact),
			direction: "granted-by-peer",
			event: "grant-received",
			note: update.note,
		});
		await this.context.trustStore.touchContact(contact.connectionId);

		this.log("info", `Grant update from ${peerLabel(contact)}`);
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
		this.log("info", `Grant request from ${peerLabel(contact)}`);
		for (const line of summarizeGrantSet(createGrantSet(request.grants))) {
			this.log("info", `  - ${line}`);
		}
		if (request.note) {
			this.log("info", `Note: ${request.note}`);
		}

		await this.appendLedger({
			peer: peerLabel(contact),
			direction: "local",
			event: "grant-request-received",
			action_id: request.actionId,
			note: request.note,
		});
	}

	private async resolvePendingRequestWithContact<T>(
		entry: RequestJournalEntry,
		parse: (metadata: Record<string, unknown> | undefined) => T | null,
		label: string,
		process: (contact: Contact, requestId: string, request: T) => Promise<void>,
	): Promise<void> {
		const request = parse(entry.metadata);
		if (!request) {
			throw new ValidationError(
				`Pending ${label} ${entry.requestId} is missing the original request payload`,
			);
		}

		const contact = findUniqueContactForAgentId(
			await this.context.trustStore.getContacts(),
			entry.peerAgentId,
		);
		if (!contact) {
			throw new ValidationError(`No active contact found for pending ${label} ${entry.requestId}`);
		}

		await process(contact, entry.requestId, request);
	}

	private async resolvePendingTransferRequest(entry: RequestJournalEntry): Promise<void> {
		await this.resolvePendingRequestWithContact(
			entry,
			parseStoredTransferRequest,
			"action request",
			(contact, requestId, request) => this.processTransferRequest(contact, requestId, request),
		);
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
		await this.resolvePendingRequestWithContact(
			entry,
			parseStoredSchedulingRequest,
			"scheduling request",
			(contact, requestId, proposal) => this.processSchedulingRequest(contact, requestId, proposal),
		);
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

		const baseResponse = {
			type: "transfer/response" as const,
			actionId: request.actionId,
			asset: request.asset,
			amount: request.amount,
			chain: request.chain,
			toAddress: request.toAddress,
		};
		const baseLedger = {
			peer: peerLabel(contact),
			direction: "granted-by-me" as const,
			scope: "transfer/request",
			asset: request.asset,
			amount: request.amount,
			action_id: request.actionId,
		};

		let response: TransferActionResponse;
		if (!approved) {
			response = { ...baseResponse, status: "rejected", error: "Action rejected by agent" };
			await this.appendLedger({
				...baseLedger,
				event: "transfer-rejected",
				decision: "rejected",
				rationale: "Rejected at runtime by agent decision",
			});
		} else if (!this.hooks.executeTransfer) {
			response = {
				...baseResponse,
				status: "failed",
				error: "No transfer executor configured for this TAP host",
			};
		} else {
			try {
				const transfer = await this.hooks.executeTransfer(this.context.config, request);
				response = { ...baseResponse, status: "completed", txHash: transfer.txHash };
				await this.appendLedger({
					...baseLedger,
					event: "transfer-completed",
					tx_hash: transfer.txHash,
					decision: "approved",
					rationale: "Approved at runtime by agent decision",
				});
			} catch (error: unknown) {
				response = {
					...baseResponse,
					status: "failed",
					error: toErrorMessage(error),
				};
				await this.appendLedger({
					...baseLedger,
					event: "transfer-failed",
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
				`Failed to persist retry metadata for action result ${response.actionId}: ${toErrorMessage(error)}`,
			);
			try {
				await this.context.transport.send(contact.peerAgentId, delivery.request, {
					peerAddress: contact.peerAgentAddress,
					waitForAck: false,
				});
				await this.appendConversationLogSafe(contact, delivery.request, "outgoing");
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

	private async handleSchedulingAction(ctx: TapActionContext): Promise<TapActionResult> {
		const contact = ctx.extensions.contact as Contact | undefined;
		const schedulingHandler = ctx.extensions.schedulingHandler as SchedulingHandler | undefined;

		// Parse the proposal from the action context payload
		const proposal = this.parseSchedulingProposalFromPayload(ctx.payload);
		if (!proposal) {
			return {
				success: false,
				error: {
					code: "INVALID_PAYLOAD",
					message: "Missing or invalid scheduling fields: title, durationMinutes, proposedSlots",
				},
			};
		}

		// If no SchedulingHandler is available, fall back to grant-only evaluation
		if (!schedulingHandler || !contact) {
			return this.handleSchedulingFallback(ctx, proposal);
		}

		// Generate a synthetic requestId from the payload schedulingId
		const requestId = proposal.schedulingId;

		const decision = await schedulingHandler.evaluateProposal(requestId, contact, proposal);

		return mapSchedulingDecisionToResult(proposal.schedulingId, decision);
	}

	private parseSchedulingProposalFromPayload(
		payload: Record<string, unknown>,
	): SchedulingProposal | null {
		const type = payload.type;
		if (type !== "scheduling/propose" && type !== "scheduling/counter") {
			// Also accept "scheduling/request" as the wire format uses it
			if (type !== "scheduling/request") {
				return null;
			}
		}

		if (typeof payload.title !== "string" || payload.title.length === 0) {
			return null;
		}

		const durationMinutes =
			typeof payload.durationMinutes === "number"
				? payload.durationMinutes
				: typeof payload.duration === "number"
					? payload.duration
					: undefined;
		if (durationMinutes === undefined || durationMinutes <= 0) {
			return null;
		}

		const rawSlots = Array.isArray(payload.proposedSlots)
			? payload.proposedSlots
			: Array.isArray(payload.slots)
				? payload.slots
				: undefined;
		if (!rawSlots || rawSlots.length === 0) {
			return null;
		}

		const slots: Array<{ start: string; end: string }> = [];
		for (const slot of rawSlots) {
			if (
				typeof slot !== "object" ||
				slot === null ||
				typeof (slot as Record<string, unknown>).start !== "string" ||
				typeof (slot as Record<string, unknown>).end !== "string"
			) {
				return null;
			}
			slots.push({ start: (slot as { start: string }).start, end: (slot as { end: string }).end });
		}

		const schedulingId =
			typeof payload.schedulingId === "string" && payload.schedulingId.length > 0
				? payload.schedulingId
				: `sch_${Date.now()}`;

		const timezone =
			typeof payload.timezone === "string" && payload.timezone.length > 0
				? payload.timezone
				: typeof payload.originTimezone === "string" && payload.originTimezone.length > 0
					? payload.originTimezone
					: "UTC";

		return {
			type: (type === "scheduling/request" ? "scheduling/propose" : type) as
				| "scheduling/propose"
				| "scheduling/counter",
			schedulingId,
			title: payload.title,
			duration: durationMinutes,
			slots,
			originTimezone: timezone,
			...(typeof payload.note === "string" && payload.note.length > 0
				? { note: payload.note }
				: {}),
		};
	}

	private handleSchedulingFallback(
		ctx: TapActionContext,
		proposal: SchedulingProposal,
	): TapActionResult {
		// Grant-only evaluation: check if grants cover this request, accept first slot
		const matchingGrants = findApplicableSchedulingGrants(
			{ version: "tap-grants/v1", updatedAt: "", grants: ctx.peer.grantsToPeer },
			proposal,
		);

		if (matchingGrants.length === 0) {
			return {
				success: false,
				data: {
					type: "scheduling/reject",
					schedulingId: proposal.schedulingId,
					reason: "No active scheduling grant covers this request",
				},
				error: {
					code: "NO_MATCHING_GRANT",
					message: "No active scheduling grant covers this request",
				},
			};
		}

		const schedulableSlots = findSchedulableSchedulingSlots(matchingGrants, proposal);

		if (schedulableSlots.length === 0) {
			return {
				success: false,
				data: {
					type: "scheduling/reject",
					schedulingId: proposal.schedulingId,
					reason: "No proposed time slots match grant constraints",
				},
				error: {
					code: "NO_MATCHING_SLOTS",
					message: "No proposed time slots match scheduling grant constraints",
				},
			};
		}

		const acceptedSlot = schedulableSlots[0] as { start: string; end: string };

		return {
			success: true,
			data: {
				type: "scheduling/accept",
				schedulingId: proposal.schedulingId,
				acceptedSlot,
				note: `Confirmed: ${proposal.title}`,
			},
		};
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

		const baseLedger = {
			peer: peerLabel(contact),
			scope: "scheduling/request",
			action_id: proposal.schedulingId,
		};

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
						getLocalTimezone(),
					);
					await this.updateSchedulingTracking(requestId, {
						schedulingState: "accepted",
						...(eventResult.eventId ? { localEventId: eventResult.eventId } : {}),
					});

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

					await this.deliverSchedulingOutgoing(contact, outgoing, "accept", proposal.schedulingId);

					await this.context.requestJournal.updateStatus(requestId, "completed");
					await this.appendLedger({
						...baseLedger,
						direction: "granted-by-me",
						event: "scheduling-accepted",
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

				await this.deliverSchedulingReject(
					contact,
					requestId,
					proposal,
					"Scheduling request declined by operator",
				);
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

				await this.deliverSchedulingOutgoing(contact, outgoing, "counter", proposal.schedulingId);

				await this.context.requestJournal.updateStatus(requestId, "completed");
				await this.appendLedger({
					...baseLedger,
					direction: "local",
					event: "scheduling-counter",
					decision: "counter",
				});
				break;
			}
			case "reject": {
				await this.deliverSchedulingReject(contact, requestId, proposal, decision.reason);
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

	private async deliverSchedulingReject(
		contact: Contact,
		requestId: string,
		proposal: SchedulingProposal,
		reason: string,
	): Promise<void> {
		await this.updateSchedulingTracking(requestId, {
			schedulingState: "rejected",
		});
		const rejectData: Record<string, unknown> = {
			type: "scheduling/reject",
			schedulingId: proposal.schedulingId,
			reason,
		};
		const rejectText = buildSchedulingRejectText({
			type: "scheduling/reject",
			schedulingId: proposal.schedulingId,
			reason,
		});
		const outgoing = buildOutgoingActionResult(
			contact,
			requestId,
			rejectText,
			rejectData,
			"scheduling/request",
			"rejected",
		);

		await this.deliverSchedulingOutgoing(contact, outgoing, "reject", proposal.schedulingId);

		await this.context.requestJournal.updateStatus(requestId, "completed");
		await this.appendLedger({
			peer: peerLabel(contact),
			direction: "granted-by-me",
			event: "scheduling-rejected",
			scope: "scheduling/request",
			action_id: proposal.schedulingId,
			decision: "rejected",
			rationale: reason,
		});
	}

	private async deliverSchedulingOutgoing(
		contact: Contact,
		outgoing: ProtocolMessage,
		actionType: string,
		schedulingId: string,
	): Promise<void> {
		try {
			await this.context.transport.send(contact.peerAgentId, outgoing, {
				peerAddress: contact.peerAgentAddress,
				waitForAck: false,
			});
			await this.appendConversationLogSafe(contact, outgoing, "outgoing");
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to deliver scheduling ${actionType} for ${schedulingId}: ${toErrorMessage(error)}`,
			);
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
				this.log("info", `Ignoring duplicate connection result from ${peerLabel(existingContact)}`);
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
			this.log("info", `Connection rejected by ${peerLabel(pendingConnect)}`);
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
		this.log("info", `Connection accepted by ${peerLabel(pendingConnect)}`);
		return "received";
	}

	private async handleActionResult(
		from: number,
		message: ProtocolMessage,
	): Promise<string | undefined> {
		const contact = await findContactForMessage(this.context, from, message);
		if (contact) {
			// Implicit handshake completion (see `onRequest` for rationale).
			// Scoped by (peerAgentId, peerChain) so cross-chain peers sharing
			// a numeric tokenId don't complete each other's pending entries.
			await this.markPendingConnectionResultsCompletedFor(contact.peerAgentId, contact.peerChain);
			await this.appendConversationLogSafe(contact, message, "incoming");
		}

		const response = parseTransferActionResponse(message);
		if (response) {
			if (contact) {
				await this.appendLedger({
					peer: peerLabel(contact),
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
				this.log("info", `Received transfer ${response.status} result from ${peerLabel(contact)}`);
			}
			return contact?.peerDisplayName;
		}

		const schedulingResponse = parseSchedulingActionResponse(message);
		if (schedulingResponse) {
			const requestId = (message.params as { requestId?: string } | undefined)?.requestId;
			const originalRequest = requestId
				? await this.context.requestJournal.getByRequestId(requestId)
				: null;
			const originalProposal = parseStoredSchedulingRequest(originalRequest?.metadata);
			const tracking = parseSchedulingTrackingMetadata(originalRequest?.metadata);

			if (schedulingResponse.type === "scheduling/accept") {
				let localEventId: string | undefined;
				if (this.schedulingHandler) {
					const eventResult = await this.schedulingHandler.handleAccept(
						schedulingResponse,
						contact?.peerDisplayName ?? "Unknown",
						originalProposal?.title ?? "Meeting",
						originalProposal?.originTimezone ?? "UTC",
					);
					localEventId = eventResult.eventId;
				}
				if (requestId) {
					await this.updateSchedulingTracking(requestId, {
						schedulingState: "accepted",
						...(localEventId ? { localEventId } : {}),
					});
				}
			} else if (schedulingResponse.type === "scheduling/cancel" && requestId) {
				const clearedLocalEvent = await this.cancelLocalSchedulingEvent(
					requestId,
					tracking.localEventId,
					`remote cancellation for ${schedulingResponse.schedulingId}`,
				);
				await this.updateSchedulingTracking(requestId, {
					schedulingState: "cancelled",
					...(clearedLocalEvent ? { localEventId: undefined } : {}),
				});
			} else if (schedulingResponse.type === "scheduling/reject" && requestId) {
				await this.updateSchedulingTracking(requestId, {
					schedulingState: "rejected",
				});
			}

			if (requestId) {
				await this.context.requestJournal.updateStatus(requestId, "completed");
			}

			if (contact) {
				const eventType = schedulingResponse.type.split("/")[1] ?? schedulingResponse.type;
				await this.appendLedger({
					peer: peerLabel(contact),
					direction: "local",
					event: `scheduling-${eventType}`,
					scope: "scheduling/request",
					action_id: schedulingResponse.schedulingId,
					decision: eventType,
				});
				this.log("info", `Received scheduling ${eventType} result from ${peerLabel(contact)}`);
			}
			return contact?.peerDisplayName;
		}

		// Generic app action result fallback — handles any result type that
		// is not a transfer or scheduling response (e.g. bet/propose, custom app actions).
		const resultData = extractMessageData(message);
		const requestId = (message.params as { requestId?: string } | undefined)?.requestId;
		if (resultData) {
			const actionType = (resultData.type as string | undefined) ?? "unknown";

			this.emitEvent({
				event: "action_result_received",
				method: ACTION_RESULT,
				actionType,
				peerAgentId: from,
				...(contact
					? {
							peerName: contact.peerDisplayName,
							connectionId: contact.connectionId,
						}
					: {}),
				data: resultData,
				...(requestId ? { requestId } : {}),
			});

			if (requestId) {
				await this.context.requestJournal.updateStatus(requestId, "completed");
				this.waiters.get(requestId)?.(resultData as TransferActionResponse);
			}

			this.log(
				"info",
				`Received ${actionType} action result from ${contact?.peerDisplayName ?? `agent #${from}`}`,
			);
		} else if (requestId) {
			// No extractable data, but still correlate with journal
			await this.context.requestJournal.updateStatus(requestId, "completed");
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
				metadata: delivery as unknown as Record<string, unknown>,
			});
			persisted = true;
			this.peersWithPendingConnectionResult.add(
				peerConnectionResultCacheKey(peer.chain, peer.agentId),
			);
		} catch (error: unknown) {
			this.log(
				"error",
				`Failed to persist retry metadata for connection result ${result.requestId}: ${toErrorMessage(error)}`,
			);
		}

		try {
			if (persisted) {
				await this.sendAndCompleteJournalEntry(delivery);
			} else {
				await this.context.transport.send(delivery.peerAgentId, delivery.request, {
					peerAddress: delivery.peerAddress,
					waitForAck: false,
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
				`Rejecting action request ${request.actionId} from ${peerLabel(contact)} because no matching active transfer grant exists`,
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

	private async retryPendingResults<T extends { peerAgentId: number; peerName: string }>(
		method: string,
		parse: (metadata: Record<string, unknown> | undefined) => T | null,
		deliver: (delivery: T) => Promise<void>,
		errorLabel: (delivery: T) => string,
	): Promise<number> {
		const pending = await this.context.requestJournal.listPending("outbound");
		let processed = 0;
		const now = Date.now();
		for (const entry of pending) {
			if (entry.kind !== "result" || entry.method !== method) {
				continue;
			}

			// Stale cleanup — prevent indefinite accumulation for peers that
			// have been offline so long that the delivery is no longer
			// meaningful. The entry is marked terminal rather than deleted so
			// the journal still carries a record of the attempt. We do NOT
			// touch `peersWithPendingConnectionResult` here: a single-entry
			// GC cannot safely prove no other pending entries remain for the
			// same peer, and cache cleanup is owned by
			// `markPendingConnectionResultsCompletedFor`.
			const createdMs = Date.parse(entry.createdAt);
			if (Number.isFinite(createdMs) && now - createdMs > PENDING_RESULT_MAX_AGE_MS) {
				this.log(
					"warn",
					`Abandoning pending ${method} delivery ${entry.requestId} for agent #${entry.peerAgentId}: older than ${Math.round(PENDING_RESULT_MAX_AGE_MS / 3_600_000)}h`,
				);
				await this.markJournalEntryCompleted(entry.requestId).catch(() => {});
				continue;
			}

			const delivery = parse(entry.metadata);
			if (!delivery) {
				continue;
			}
			try {
				await deliver(delivery);
				processed += 1;
			} catch (error: unknown) {
				this.logResultDeliveryFailure(
					errorLabel(delivery),
					`${delivery.peerName} (#${delivery.peerAgentId})`,
					error,
				);
				await this.recordDeliveryFailure(entry.requestId, entry.metadata, error);
			}
		}
		return processed;
	}

	/**
	 * Merge `lastError` / `lastAttemptAt` / `attempts` into the journal entry's
	 * metadata so `listPendingDeliveries` — and by extension the sync report —
	 * can surface a real reason for stuck deliveries. Failures are best-effort:
	 * if the metadata update itself fails we don't want to lose the original
	 * delivery payload, so we catch and continue.
	 */
	private async recordDeliveryFailure(
		requestId: string,
		metadata: Record<string, unknown> | undefined,
		error: unknown,
	): Promise<void> {
		try {
			const previousFailure = parseDeliveryFailureMetadata(metadata);
			const nextFailure: DeliveryFailureMetadata = {
				type: "delivery-failure",
				attempts: (previousFailure?.attempts ?? 0) + 1,
				lastAttemptAt: nowISO(),
				lastError: toErrorMessage(error),
			};
			await this.context.requestJournal.updateMetadata(requestId, {
				...(metadata ?? {}),
				[DELIVERY_FAILURE_METADATA_KEY]: nextFailure,
			});
		} catch (updateError: unknown) {
			this.log(
				"warn",
				`Failed to record delivery failure for ${requestId}: ${toErrorMessage(updateError)}`,
			);
		}
	}

	private retryPendingActionResults(): Promise<number> {
		return this.retryPendingResults(
			ACTION_RESULT,
			parsePendingActionResultDelivery,
			(d) => this.deliverPendingActionResult(d),
			(d) => `Action result ${d.actionId}`,
		);
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
					`Failed to retry connection request ${entry.requestId}: ${toErrorMessage(error)}`,
				);
			}
		}
		return processed;
	}

	private retryPendingConnectionResults(): Promise<number> {
		return this.retryPendingResults(
			CONNECTION_RESULT,
			parsePendingConnectionResultDelivery,
			(d) => this.sendAndCompleteJournalEntry(d),
			() => "Connection result",
		);
	}

	/**
	 * Implicit handshake completion. Any inbound protocol message from a peer
	 * with whom we already have an active contact is proof that the peer has
	 * received and accepted our previous connection/result — otherwise the
	 * transport would have rejected the message as "Unknown sender" instead
	 * of routing it here. When that happens, any pending outbound
	 * connection/result entries for that peer become load-bearing no more,
	 * and we complete them so the retry pipeline stops hammering and the
	 * sync report stops reporting stuck handshake work.
	 *
	 * Matching is scoped by (chain, agentId) because two active contacts can
	 * legitimately share the same numeric agentId across chains. Each pending
	 * entry's metadata carries the target `peerChain`; entries whose chain
	 * does not match the inbound peer are left untouched.
	 */
	private async markPendingConnectionResultsCompletedFor(
		peerAgentId: number,
		peerChain: string,
	): Promise<void> {
		// Hot-path short-circuit: only pay for the journal scan if we know
		// this (chain, peer) has a pending connection/result entry. The
		// cache is populated lazily on first miss (see
		// `primeConnectionResultCache`), updated by `sendConnectionResult`
		// when a new entry is persisted, and kept in sync on successful
		// completion below.
		await this.primeConnectionResultCache();
		const cacheKey = peerConnectionResultCacheKey(peerChain, peerAgentId);
		if (!this.peersWithPendingConnectionResult.has(cacheKey)) {
			return;
		}

		let pending: RequestJournalEntry[];
		try {
			pending = await this.context.requestJournal.listPending("outbound");
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to scan pending outbound deliveries for implicit completion: ${toErrorMessage(error)}`,
			);
			return;
		}

		let remainingForPeer = false;
		for (const entry of pending) {
			if (entry.kind !== "result" || entry.method !== CONNECTION_RESULT) {
				continue;
			}
			if (entry.peerAgentId !== peerAgentId) {
				continue;
			}
			// Chain scoping: parse the metadata to read `peerChain`.
			const delivery = parsePendingConnectionResultDelivery(entry.metadata);
			if (!delivery || delivery.peerChain === undefined) {
				// Unparseable, or a legacy entry without peerChain — we
				// can't tell which (chain, agentId) cache key this belongs
				// to. Treat as possibly-ours and keep the current cache
				// entry around so a future scan can retry. The direct
				// retry pipeline still handles delivery.
				remainingForPeer = true;
				continue;
			}
			if (delivery.peerChain !== peerChain) {
				// Belongs to a different (chain, agentId) cache key. Leave it
				// untouched — it does NOT affect whether we can delete our
				// own cache entry.
				continue;
			}
			try {
				await this.markJournalEntryCompleted(entry.requestId);
				this.log(
					"info",
					`Implicitly completed pending connection result ${entry.requestId} for agent #${peerAgentId} on ${peerChain} — peer is already sending active traffic`,
				);
			} catch (error: unknown) {
				remainingForPeer = true;
				this.log(
					"warn",
					`Failed to implicitly complete pending connection result ${entry.requestId}: ${toErrorMessage(error)}`,
				);
			}
		}
		if (!remainingForPeer) {
			this.peersWithPendingConnectionResult.delete(cacheKey);
		}
	}

	/**
	 * Populate {@link peersWithPendingConnectionResult} from the journal on
	 * first access so a freshly-constructed service sees pre-existing entries
	 * left over from the previous process run. Concurrent callers share the
	 * same priming promise so no caller sees an in-flight empty cache (which
	 * would cause false-negative short-circuits on inbound traffic). Best-
	 * effort: on failure, the cache stays unprimed and a future call retries.
	 */
	private async primeConnectionResultCache(): Promise<void> {
		if (this.connectionResultCachePrimed) {
			return;
		}
		if (!this.connectionResultCachePriming) {
			this.connectionResultCachePriming = (async () => {
				try {
					const pending = await this.context.requestJournal.listPending("outbound");
					for (const entry of pending) {
						if (entry.kind !== "result" || entry.method !== CONNECTION_RESULT) {
							continue;
						}
						// Pull chain from metadata so the cache key matches
						// the (chain, agentId) shape used by the lookup path.
						// Legacy entries without `peerChain` in metadata are
						// skipped — the direct retry pipeline still delivers
						// them, at the cost of missing the implicit-completion
						// short-circuit until they age out.
						const delivery = parsePendingConnectionResultDelivery(entry.metadata);
						if (!delivery || delivery.peerChain === undefined) {
							continue;
						}
						this.peersWithPendingConnectionResult.add(
							peerConnectionResultCacheKey(delivery.peerChain, entry.peerAgentId),
						);
					}
					this.connectionResultCachePrimed = true;
				} catch (error: unknown) {
					this.log(
						"warn",
						`Failed to prime pending connection-result cache: ${toErrorMessage(error)}`,
					);
				} finally {
					this.connectionResultCachePriming = null;
				}
			})();
		}
		await this.connectionResultCachePriming;
	}

	private async sendAndCompleteJournalEntry(delivery: {
		peerAgentId: number;
		request: ProtocolMessage;
		peerAddress: `0x${string}`;
	}): Promise<void> {
		await this.context.transport.send(delivery.peerAgentId, delivery.request, {
			peerAddress: delivery.peerAddress,
			waitForAck: false,
		});
		await this.markJournalEntryCompleted(String(delivery.request.id));
		// Deliberately do NOT touch `peersWithPendingConnectionResult` here.
		// A single-entry completion cannot tell us whether other pending
		// connection/result entries for the same peer still exist, and an
		// unconditional delete would cause `markPendingConnectionResultsCompletedFor`
		// to skip the journal scan on the next inbound and orphan the
		// remaining entries. Cache cleanup is owned by
		// `markPendingConnectionResultsCompletedFor`, which scans before
		// deleting. A stale-positive cache entry only costs an extra scan.
	}

	/**
	 * Terminal state for a journal entry: mark completed and clear any retry
	 * metadata. Errors propagate — callers that want to swallow (implicit
	 * cleanup, stale-entry GC) wrap the call themselves.
	 */
	private async markJournalEntryCompleted(requestId: string): Promise<void> {
		await this.context.requestJournal.updateStatus(requestId, "completed");
		await this.context.requestJournal.updateMetadata(requestId, undefined);
	}

	private async deliverPendingActionResult(delivery: PendingActionResultDelivery): Promise<void> {
		await this.sendAndCompleteJournalEntry(delivery);
		const contact = await this.context.trustStore.getContact(delivery.connectionId);
		if (!contact || contact.peerAgentId !== delivery.peerAgentId) {
			return;
		}
		await this.appendConversationLogSafe(contact, delivery.request, "outgoing");
	}

	private logActionResultDeliveryFailure(contact: Contact, actionId: string, error: unknown): void {
		this.logResultDeliveryFailure(`Action result ${actionId}`, peerLabel(contact), error);
	}

	private logResultDeliveryFailure(subject: string, peerLabel: string, error: unknown): void {
		const errorMessage = toErrorMessage(error);
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

	private async sendUnsupportedActionResult(
		contact: Contact,
		requestId: string,
		actionType: string,
		_requestKey: string,
	): Promise<void> {
		const errorData: Record<string, unknown> = {
			error: {
				code: "UNSUPPORTED_ACTION",
				message: `No handler registered for action type "${actionType}"`,
			},
		};
		const outgoing = buildOutgoingActionResult(
			contact,
			requestId,
			`Unsupported action type: ${actionType}`,
			errorData,
			actionType,
			"failed",
		);

		try {
			await this.context.transport.send(contact.peerAgentId, outgoing, {
				peerAddress: contact.peerAgentAddress,
				waitForAck: false,
			});
			await this.appendConversationLogSafe(contact, outgoing, "outgoing");
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to deliver UNSUPPORTED_ACTION result for "${actionType}": ${toErrorMessage(error)}`,
			);
		}
	}

	private async rejectMalformedPayload(
		contact: Contact,
		messageId: string,
		fallbackActionType: string,
		requestKey: string,
		isDuplicate: boolean,
	): Promise<{ status: "duplicate" | "received" }> {
		await this.sendUnsupportedActionResult(contact, messageId, fallbackActionType, requestKey);
		await this.context.requestJournal.updateStatus(messageId, "completed");
		return { status: isDuplicate ? "duplicate" : "received" };
	}

	private async dispatchToApp(
		contact: Contact,
		requestId: string,
		resolved: {
			app: import("../app/types.js").TapApp;
			handler: import("../app/types.js").TapActionHandler;
		},
		payload: Record<string, unknown>,
		_requestKey: string,
	): Promise<void> {
		const agentAddress = await this.getLocalAgentAddress();
		const actionType = typeof payload.type === "string" ? payload.type : resolved.app.id;

		// Extract text from the request
		let text: string | undefined;
		// We don't have the raw message here, so text is not extracted from the wire.
		// Apps that need it should read from payload.

		const conversationId = contact.connectionId;
		const ctx = buildActionContext({
			config: this.context.config,
			agentAddress,
			contact,
			payload,
			text,
			app: resolved.app,
			reply: async (replyText: string) => {
				await this.sendMessageInternal(
					String(contact.peerAgentId),
					replyText,
					DEFAULT_MESSAGE_SCOPE,
				);
			},
			sendToPeer: async (peerId: number, sendText: string) => {
				await this.sendMessageInternal(String(peerId), sendText, DEFAULT_MESSAGE_SCOPE);
			},
			requestPayment: async (_params) => {
				// Delegate to requestFunds if available
				throw new ValidationError("Payment request not supported in app dispatch context");
			},
			executeTransfer: async (params) => {
				if (!this.hooks.executeTransfer) {
					throw new ValidationError("No transfer executor configured");
				}
				const result = await this.hooks.executeTransfer(this.context.config, {
					type: "transfer/request",
					actionId: generateNonce(),
					asset: params.asset as "native" | "usdc",
					amount: params.amount,
					chain: params.chain,
					toAddress: params.toAddress,
					note: params.note,
				});
				return result;
			},
			emitEvent: (event) => {
				this.emitEvent({
					type: event.type,
					summary: event.summary,
					appId: resolved.app.id,
					...event.data,
				});
			},
			conversationLogger: this.context.conversationLogger,
			conversationId,
			extensions: {
				schedulingHandler: this.schedulingHandler,
				contact,
			},
		});

		let result: TapActionResult;
		try {
			result = await resolved.handler.handler(ctx);
		} catch (error: unknown) {
			result = {
				success: false,
				error: {
					code: "HANDLER_ERROR",
					message: toErrorMessage(error),
				},
			};
		}

		// DEFERRED means the request should stay pending for later resolution.
		// Do not send a result or complete the journal entry.
		if (result.error?.code === "DEFERRED") {
			this.log(
				"info",
				`Action ${actionType} deferred for approval; request ${requestId} stays pending`,
			);
			return;
		}

		const resultData: Record<string, unknown> = {
			type: actionType,
			...(result.data ?? {}),
			...(result.error ? { error: result.error } : {}),
		};
		const resultStatus = result.success ? "completed" : "failed";
		const resultText = result.success
			? `Action ${actionType} completed`
			: `Action ${actionType} failed: ${result.error?.message ?? "unknown error"}`;
		const outgoing = buildOutgoingActionResult(
			contact,
			requestId,
			resultText,
			resultData,
			actionType,
			resultStatus,
		);

		// Mark the inbound request completed before delivery — the handler has
		// already executed and its side effects are committed.
		await this.context.requestJournal.updateStatus(requestId, "completed");

		// Persist an outbound journal entry so reconciliation can retry delivery
		// if the transport send fails (follows the same pattern as transfer results).
		try {
			await this.context.requestJournal.putOutbound({
				requestId: String(outgoing.id),
				requestKey: `outbound:${outgoing.method}:${String(outgoing.id)}`,
				direction: "outbound",
				kind: "result",
				method: outgoing.method,
				peerAgentId: contact.peerAgentId,
				correlationId: requestId,
				status: "pending",
				metadata: {
					type: "action-result-delivery",
					actionId: typeof resultData.actionId === "string" ? resultData.actionId : requestId,
					connectionId: contact.connectionId,
					peerAgentId: contact.peerAgentId,
					peerName: contact.peerDisplayName,
					peerAddress: contact.peerAgentAddress,
					request: outgoing,
				} as unknown as Record<string, unknown>,
			});
		} catch (journalError: unknown) {
			this.log(
				"error",
				`Failed to persist retry metadata for app result "${actionType}": ${toErrorMessage(journalError)}`,
			);
			// Best-effort delivery without retry
			try {
				await this.context.transport.send(contact.peerAgentId, outgoing, {
					peerAddress: contact.peerAgentAddress,
					waitForAck: false,
				});
				await this.appendConversationLogSafe(contact, outgoing, "outgoing");
			} catch (deliveryError: unknown) {
				this.log(
					"warn",
					`Failed to deliver app result for "${actionType}": ${toErrorMessage(deliveryError)}`,
				);
			}
		}
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

function parseSchedulingTrackingMetadata(
	metadata: Record<string, unknown> | undefined,
): SchedulingTrackingMetadata {
	if (!metadata) {
		return {};
	}

	const ss = metadata.schedulingState;
	const schedulingState: SchedulingRequestState | undefined =
		ss === "accepted" || ss === "cancelled" || ss === "rejected" ? ss : undefined;
	return {
		...(typeof metadata.localEventId === "string" && metadata.localEventId.length > 0
			? { localEventId: metadata.localEventId }
			: {}),
		...(schedulingState ? { schedulingState } : {}),
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function mergeMetadata(
	existing: Record<string, unknown> | undefined,
	updates: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...(existing ?? {}) };
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined) {
			delete next[key];
			continue;
		}
		next[key] = value;
	}
	return next;
}

function serializePendingTransferRequestDetails(
	contact: Contact,
	request: TransferActionRequest,
	dataDir: string,
): Record<string, unknown> {
	return {
		...(buildPendingTransferDetails(contact, request, dataDir) as unknown as Record<
			string,
			unknown
		>),
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
	direction: "inbound" | "outbound",
): Record<string, unknown> {
	const grants =
		direction === "inbound"
			? findApplicableSchedulingGrants(contact.permissions.grantedByMe, request)
			: findActiveGrantsByScope(contact.permissions.grantedByPeer, "scheduling/request");
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
		...(details as unknown as Record<string, unknown>),
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

function getLocalTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
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
	// Deterministic id keyed by (chain, peer agentId, correlation) so repeated
	// calls upsert a single journal entry instead of accumulating one per retry
	// (bounds pending set). Peer identity is part of the key because JSON-RPC
	// ids are only unique within a single client's request space — two peers
	// can use the same correlationId without scoping.
	const request = buildConnectionResult(
		result,
		deriveConnectionResultId({
			chain: peer.chain,
			peerAgentId: peer.agentId,
			correlationId: result.requestId,
		}),
	);
	return {
		type: "connection-result-delivery",
		peerAgentId: peer.agentId,
		peerChain: peer.chain,
		peerName: peer.registrationFile.name,
		peerAddress: peer.xmtpEndpoint ?? peer.agentAddress,
		request,
	};
}

/**
 * Cache key for the pending-connection-result short-circuit set. Peers are
 * uniquely identified by (chain, agentId), not agentId alone — two peers on
 * different chains can legitimately share the same numeric tokenId.
 */
function peerConnectionResultCacheKey(chain: string, agentId: number): string {
	return `${chain}:${agentId}`;
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

	// peerChain is optional for backward compatibility with entries written
	// before the field was introduced. Missing/empty chain means the entry
	// cannot participate in chain-scoped implicit completion, but the direct
	// retry pipeline still delivers it.
	const peerChain =
		typeof metadata.peerChain === "string" && metadata.peerChain.length > 0
			? metadata.peerChain
			: undefined;

	return {
		type: "connection-result-delivery",
		peerAgentId: metadata.peerAgentId,
		...(peerChain ? { peerChain } : {}),
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

function toPendingRequestView(entry: RequestJournalEntry): TapPendingRequest {
	return {
		requestId: entry.requestId,
		method: entry.method,
		peerAgentId: entry.peerAgentId,
		direction: entry.direction,
		kind: entry.kind,
		status: entry.status,
		correlationId: entry.correlationId,
		details: parsePendingRequestDetails(entry.metadata),
	};
}

function toPendingDeliveryView(entry: RequestJournalEntry, now: number): TapPendingDelivery {
	const createdMs = Date.parse(entry.createdAt);
	const ageMs = Number.isFinite(createdMs) ? now - createdMs : 0;
	const failure = parseDeliveryFailureMetadata(entry.metadata);
	return {
		requestId: entry.requestId,
		method: entry.method,
		peerAgentId: entry.peerAgentId,
		...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
		ageMs,
		...(failure?.attempts !== undefined ? { attempts: failure.attempts } : {}),
		...(failure?.lastAttemptAt ? { lastAttemptAt: failure.lastAttemptAt } : {}),
		...(failure?.lastError ? { lastError: failure.lastError } : {}),
	};
}

function parseDeliveryFailureMetadata(
	metadata: Record<string, unknown> | undefined,
): DeliveryFailureMetadata | null {
	if (!metadata) {
		return null;
	}
	const raw = metadata[DELIVERY_FAILURE_METADATA_KEY];
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const candidate = raw as Partial<DeliveryFailureMetadata>;
	if (
		candidate.type !== "delivery-failure" ||
		typeof candidate.attempts !== "number" ||
		typeof candidate.lastAttemptAt !== "string" ||
		typeof candidate.lastError !== "string"
	) {
		return null;
	}
	return candidate as DeliveryFailureMetadata;
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

export function findApplicableTransferGrants(
	grantSet: PermissionGrantSet,
	request: TransferActionRequest,
) {
	return findActiveGrantsByScope(grantSet, "transfer/request").filter((grant) =>
		matchesTransferGrantRequest(grant, request),
	);
}

export function matchesTransferGrantRequest(
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
	const metadataConnectionId = extractConnectionIdFromParams(message.params);
	if (metadataConnectionId) {
		const contact = await context.trustStore.getContact(metadataConnectionId);
		if (contact?.peerAgentId === from) {
			return contact;
		}
	}

	const contacts = await context.trustStore.getContacts();

	if (message.method === CONNECTION_RESULT) {
		const params = parseConnectionResult(message);
		return (
			contacts.find(
				(c) =>
					c.peerAgentId === params.from.agentId &&
					c.peerChain === params.from.chain &&
					c.status === "active",
			) ?? null
		);
	}

	if (message.method === PERMISSIONS_UPDATE) {
		const params = parsePermissionsUpdate(message);
		const peer = resolvePermissionsUpdatePeer(context.config, params);
		return (
			contacts.find(
				(c) =>
					c.peerAgentId === peer.agentId && c.peerChain === peer.chain && c.status === "active",
			) ?? null
		);
	}

	return findUniqueContactForAgentId(contacts, from) ?? null;
}

function assertNever(value: never): never {
	throw new ValidationError(`Unsupported queued TAP job type: ${String(value)}`);
}

export { TransportOwnershipError };
