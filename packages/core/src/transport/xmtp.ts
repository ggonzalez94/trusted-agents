import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@xmtp/node-sdk";
import type { DecodedMessage, Dm } from "@xmtp/node-sdk";
import { hexToBytes, keccak256, toHex } from "viem";
import { TransportError, isEthereumAddress, nowISO } from "../common/index.js";
import type { IAgentResolver } from "../identity/resolver.js";
import { CONNECTION_REQUEST, CONNECTION_RESULT, isResultMethod } from "../protocol/index.js";
import type { AgentIdentifier } from "../protocol/types.js";
import type { ITrustStore } from "../trust/trust-store.js";
import type { Contact } from "../trust/types.js";
import type {
	ProtocolMessage,
	TransportAck,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
	TransportReconcileOptions,
	TransportReconcileResult,
} from "./interface.js";
import type { TransportSendOptions } from "./types.js";
import { createXmtpSigner } from "./xmtp-signer.js";
import { FileXmtpSyncStateStore, type XmtpConversationCheckpoint } from "./xmtp-sync-state.js";
import type { XmtpTransportConfig } from "./xmtp-types.js";

/** IdentifierKind.Ethereum from @xmtp/node-bindings (const enum, value inlined to avoid verbatimModuleSyntax issues) */
const IDENTIFIER_KIND_ETHEREUM = 0 as const;
const MESSAGE_SORT_BY_SENT_AT = 0 as const;
const SORT_DIRECTION_ASCENDING = 0 as const;

const RECONNECT_DELAY_MS = 5_000;
const INBOUND_REQUEST_DEDUPE_TTL_MS = 10 * 60 * 1_000;
const MAX_TRACKED_INBOUND_REQUESTS = 4_096;

interface PendingRequest {
	resolve: (receipt: TransportReceipt) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	senderInboxId: string;
}

interface IncomingTransportMessage {
	senderInboxId: string;
	content: unknown;
	conversationId?: string;
	messageId?: string;
	sentAtNs?: bigint;
}

export class XmtpTransport implements TransportProvider {
	private client: Client | null = null;
	private handlers: TransportHandlers = {};
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly processedIncomingRequests = new Map<string, number>();
	private running = false;
	private streamCloser?: { return?: (value?: unknown) => Promise<unknown> };
	private readonly inboxIdToAddress = new Map<string, `0x${string}`>();
	private readonly agentResolver?: IAgentResolver;
	private readonly resolveCacheTtlMs: number;
	private readonly syncState: FileXmtpSyncStateStore | null;

	constructor(
		private readonly config: XmtpTransportConfig,
		private readonly trustStore: ITrustStore,
	) {
		this.agentResolver = config.agentResolver;
		this.resolveCacheTtlMs = config.resolveCacheTtlMs ?? 86_400_000;
		this.syncState =
			config.syncStatePath || config.dbPath
				? new FileXmtpSyncStateStore(
						config.syncStatePath ?? join(config.dbPath ?? ".", "sync-state.json"),
					)
				: null;
	}

	setHandlers(handlers: TransportHandlers): void {
		this.handlers = { ...handlers };
	}

	async start(): Promise<void> {
		if (this.running && this.client) {
			return;
		}

		const signer = createXmtpSigner(this.config.privateKey);
		const dbEncryptionKey = this.config.dbEncryptionKey
			? hexToBytes(this.config.dbEncryptionKey)
			: hexToBytes(keccak256(toHex(`xmtp-db-encryption:${this.config.privateKey}`)));
		if (this.config.dbPath) {
			await mkdir(this.config.dbPath, { recursive: true, mode: 0o700 });
		}

		this.client = await Client.create(signer, {
			env: this.config.env ?? "production",
			dbEncryptionKey,
			...(this.config.dbPath
				? { dbPath: (inboxId: string) => `${this.config.dbPath}/${inboxId}.db3` }
				: {}),
		});

		this.running = true;
		await this.populateInboxIdCache();
		this.listenWithReconnect();
	}

	async send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<TransportReceipt> {
		if (!this.client) {
			throw new TransportError("XMTP client not started");
		}

		let peerAddress: `0x${string}`;
		let connectionId: string | undefined;

		if (options?.peerAddress) {
			peerAddress = options.peerAddress;
		} else {
			const contact = await this.trustStore.findByAgentId(peerId, this.config.chain);
			if (!contact) {
				throw new TransportError(`No contact found for agent ${peerId}`);
			}
			peerAddress = contact.peerAgentAddress;
			connectionId = contact.connectionId;
		}

		const inboxId = await this.resolveInboxId(peerAddress);
		const dm = await this.client.conversations.createDm(inboxId);
		const requestId = String(message.id);
		const timeout = options?.timeout ?? this.config.defaultResponseTimeoutMs ?? 30_000;

		const receiptPromise = new Promise<TransportReceipt>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new TransportError(`Response timeout for message ${requestId}`));
			}, timeout);

			this.pendingRequests.set(requestId, {
				resolve,
				reject,
				timer,
				senderInboxId: inboxId,
			});
		});

		try {
			await dm.sendText(JSON.stringify(message));
		} catch (err) {
			const pending = this.pendingRequests.get(requestId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(requestId);
			}
			throw err instanceof TransportError
				? err
				: new TransportError(
						`Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
					);
		}

		const receipt = await receiptPromise;
		if (connectionId) {
			this.trustStore.touchContact(connectionId).catch(() => {});
		}
		return receipt;
	}

	async reconcile(options?: TransportReconcileOptions): Promise<TransportReconcileResult> {
		if (!this.client) {
			throw new TransportError("XMTP client not started");
		}

		if (!this.syncState) {
			return await this.reconcileAllMessages(options);
		}

		await this.client.conversations.syncAll(
			options?.consentStates as Parameters<Client["conversations"]["syncAll"]>[0],
		);

		const dms = this.client.conversations.listDms();
		const initialized = await this.syncState.isInitialized();
		if (!initialized) {
			await this.syncState.initializeAtHead(await this.buildConversationHeadCheckpoints(dms));
			return {
				synced: true,
				processed: 0,
			};
		}

		let processed = 0;
		for (const dm of dms) {
			processed += await this.reconcileConversation(dm);
		}

		return {
			synced: true,
			processed,
		};
	}

	async isReachable(peerId: number): Promise<boolean> {
		if (!this.client) return false;

		const contact = await this.trustStore.findByAgentId(peerId, this.config.chain);
		if (!contact) return false;

		try {
			const normalizedAddress = contact.peerAgentAddress.toLowerCase();
			const result = await this.client.canMessage([
				{
					identifier: normalizedAddress,
					identifierKind: IDENTIFIER_KIND_ETHEREUM,
				},
			]);
			return result.get(normalizedAddress) === true;
		} catch {
			return false;
		}
	}

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		this.running = false;

		try {
			await this.streamCloser?.return?.(undefined);
		} catch {
			// Ignore stream close errors
		}

		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(new TransportError("Transport stopped"));
		}
		this.pendingRequests.clear();
		this.processedIncomingRequests.clear();
		this.client = null;
	}

	private async populateInboxIdCache(): Promise<void> {
		if (!this.client) return;
		const contacts = await this.trustStore.getContacts();
		for (const contact of contacts) {
			try {
				await this.resolveInboxId(contact.peerAgentAddress);
			} catch {
				// Skip contacts not registered on XMTP
			}
		}
	}

	private listenWithReconnect(): void {
		(async () => {
			while (this.running) {
				try {
					await this.listenForMessages();
				} catch {
					// Stream failed — will retry after delay
				}
				if (this.running) {
					await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
				}
			}
		})();
	}

	private async listenForMessages(): Promise<void> {
		if (!this.client) return;

		const stream = await this.client.conversations.streamAllDmMessages({
			disableSync: true,
		});
		this.streamCloser = stream;

		for await (const message of stream) {
			if (!this.running) break;
			try {
				await this.processMessage({
					senderInboxId: message.senderInboxId,
					content: message.content,
					conversationId: message.conversationId,
					messageId: message.id,
					sentAtNs: message.sentAtNs,
				});
				await this.advanceCheckpoint(message.conversationId, message.sentAtNs, message.id);
			} catch {
				// Leave the checkpoint unchanged so transient failures can be retried.
			}
		}
	}

	private async reconcileAllMessages(
		options?: TransportReconcileOptions,
	): Promise<TransportReconcileResult> {
		if (!this.client) {
			throw new TransportError("XMTP client not started");
		}

		await this.client.conversations.syncAll(
			options?.consentStates as Parameters<Client["conversations"]["syncAll"]>[0],
		);

		let processed = 0;
		for (const dm of this.client.conversations.listDms()) {
			const messages = await dm.messages();
			messages.sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
			for (const message of messages) {
				const didProcess = await this.processMessage({
					senderInboxId: message.senderInboxId,
					content: message.content,
					conversationId: message.conversationId,
					messageId: message.id,
					sentAtNs: message.sentAtNs,
				});
				if (didProcess) {
					processed += 1;
				}
			}
		}

		return {
			synced: true,
			processed,
		};
	}

	private async buildConversationHeadCheckpoints(
		dms: Dm[],
	): Promise<Record<string, XmtpConversationCheckpoint>> {
		const checkpoints: Record<string, XmtpConversationCheckpoint> = {};
		for (const dm of dms) {
			const lastMessage = await dm.lastMessage();
			if (!lastMessage) {
				continue;
			}
			checkpoints[dm.id] = {
				lastSentAtNs: lastMessage.sentAtNs.toString(),
				lastMessageIds: [lastMessage.id],
			};
		}
		return checkpoints;
	}

	private async reconcileConversation(dm: Dm): Promise<number> {
		if (!this.syncState) {
			return 0;
		}

		const checkpoint = await this.syncState.getCheckpoint(dm.id);
		const messages = await dm.messages(buildMessageQuery(checkpoint));

		let processed = 0;
		for (const message of messages) {
			if (isMessageAlreadyCheckpointed(checkpoint, message)) {
				continue;
			}
			const didProcess = await this.processMessage({
				senderInboxId: message.senderInboxId,
				content: message.content,
				conversationId: message.conversationId,
				messageId: message.id,
				sentAtNs: message.sentAtNs,
			});
			await this.advanceCheckpoint(dm.id, message.sentAtNs, message.id);
			if (didProcess) {
				processed += 1;
			}
		}

		return processed;
	}

	private async processMessage(message: IncomingTransportMessage): Promise<boolean> {
		if (message.senderInboxId === this.client?.inboxId) {
			return false;
		}

		const content = typeof message.content === "string" ? message.content : null;
		if (!content) {
			return false;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			return false;
		}

		if (typeof parsed !== "object" || parsed === null) {
			return false;
		}

		const payload = parsed as Record<string, unknown>;
		if (payload.jsonrpc !== "2.0") {
			return false;
		}

		if ("result" in payload || "error" in payload) {
			return this.processIncomingReceipt(message.senderInboxId, payload);
		}

		if (!("method" in payload)) {
			return false;
		}

		const request = payload as unknown as ProtocolMessage;
		if (this.isDuplicateIncomingRequest(message.senderInboxId, request)) {
			return false;
		}

		const handled = await this.handleIncomingProtocolMessage(message, request);
		if (handled) {
			this.markIncomingRequestProcessed(message.senderInboxId, request);
		}
		return handled;
	}

	private processIncomingReceipt(senderInboxId: string, payload: Record<string, unknown>): boolean {
		const requestId = String(payload.id);
		const pending = this.pendingRequests.get(requestId);
		if (!pending) {
			return false;
		}
		if (pending.senderInboxId !== senderInboxId) {
			return false;
		}

		clearTimeout(pending.timer);
		this.pendingRequests.delete(requestId);

		if ("error" in payload && payload.error && typeof payload.error === "object") {
			const errorMessage =
				typeof (payload.error as { message?: unknown }).message === "string"
					? (payload.error as { message: string }).message
					: `Peer returned an error for message ${requestId}`;
			pending.reject(new TransportError(errorMessage));
			return true;
		}

		const result = payload.result;
		if (typeof result !== "object" || result === null) {
			pending.reject(new TransportError(`Invalid receipt payload for message ${requestId}`));
			return true;
		}

		const receipt = result as Record<string, unknown>;
		if (
			receipt.received !== true ||
			typeof receipt.status !== "string" ||
			(receipt.status !== "received" &&
				receipt.status !== "duplicate" &&
				receipt.status !== "queued")
		) {
			pending.reject(new TransportError(`Invalid receipt payload for message ${requestId}`));
			return true;
		}

		pending.resolve({
			received: true,
			requestId:
				typeof receipt.requestId === "string" && receipt.requestId.length > 0
					? receipt.requestId
					: requestId,
			status: receipt.status,
			receivedAt:
				typeof receipt.receivedAt === "string" && receipt.receivedAt.length > 0
					? receipt.receivedAt
					: nowISO(),
		});
		return true;
	}

	private async handleIncomingProtocolMessage(
		rawMessage: IncomingTransportMessage,
		message: ProtocolMessage,
	): Promise<boolean> {
		if (!this.client) {
			return false;
		}

		const senderAddresses = await this.resolveInboxAddresses(rawMessage.senderInboxId);
		const senderContact = await this.findContactByAddresses(senderAddresses);
		const resultMethod = isResultMethod(message.method);

		let senderId: number;
		if (senderContact) {
			if (!this.isContactAllowedForMethod(senderContact, message.method)) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					message.id,
					-32003,
					"Sender connection is not active for this method",
				);
				return false;
			}
			senderId = senderContact.peerAgentId;
		} else if (message.method === CONNECTION_REQUEST || message.method === CONNECTION_RESULT) {
			try {
				senderId = await this.verifyBootstrapSender(
					rawMessage.senderInboxId,
					senderAddresses,
					message,
				);
			} catch (error) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					message.id,
					-32001,
					error instanceof Error ? error.message : "Bootstrap sender verification failed",
				);
				return false;
			}
		} else {
			await this.sendJsonRpcError(rawMessage.senderInboxId, message.id, -32001, "Unknown sender");
			return false;
		}

		const handler = resultMethod ? this.handlers.onResult : this.handlers.onRequest;
		if (!handler) {
			await this.sendJsonRpcError(
				rawMessage.senderInboxId,
				message.id,
				-32601,
				`No transport handler registered for ${resultMethod ? "results" : "requests"}`,
			);
			return false;
		}

		let ack: TransportAck;
		try {
			ack = await handler({
				from: senderId,
				senderInboxId: rawMessage.senderInboxId,
				message,
			});
		} catch (error) {
			await this.sendJsonRpcError(
				rawMessage.senderInboxId,
				message.id,
				-32603,
				error instanceof Error ? error.message : "Internal error",
			);
			return false;
		}

		await this.sendJsonRpcReceipt(rawMessage.senderInboxId, message.id, String(message.id), ack);
		return true;
	}

	private isContactAllowedForMethod(contact: Contact, _method: string): boolean {
		return contact.status === "active";
	}

	private async verifyBootstrapSender(
		senderInboxId: string,
		senderAddresses: `0x${string}`[],
		message: ProtocolMessage,
	): Promise<number> {
		const claimedSender = this.extractBootstrapSender(message.params);
		const claimedAgentId = claimedSender?.agentId;
		const claimedChain = claimedSender?.chain;

		if (
			typeof claimedAgentId !== "number" ||
			claimedAgentId < 0 ||
			typeof claimedChain !== "string" ||
			claimedChain.length === 0
		) {
			throw new TransportError("Invalid bootstrap sender identity");
		}

		if (!this.agentResolver) {
			throw new TransportError("Bootstrap sender verification unavailable");
		}

		const resolved = await this.agentResolver
			.resolveWithCache(claimedAgentId, claimedChain, this.resolveCacheTtlMs)
			.catch(() => null);
		if (!resolved) {
			throw new TransportError("Failed to resolve bootstrap sender identity");
		}

		const expectedSenderAddress = resolved.agentAddress.toLowerCase();
		const verified = senderAddresses.some(
			(address) => address.toLowerCase() === expectedSenderAddress,
		);
		if (!verified) {
			throw new TransportError("Sender identity verification failed");
		}

		this.inboxIdToAddress.set(senderInboxId, expectedSenderAddress as `0x${string}`);
		return claimedAgentId;
	}

	private extractBootstrapSender(params: unknown): AgentIdentifier | null {
		if (typeof params !== "object" || params === null) {
			return null;
		}

		const from = (params as { from?: unknown }).from;
		if (typeof from !== "object" || from === null) {
			return null;
		}

		const agentId = (from as { agentId?: unknown }).agentId;
		const chain = (from as { chain?: unknown }).chain;
		if (
			typeof agentId !== "number" ||
			agentId < 0 ||
			typeof chain !== "string" ||
			chain.length === 0
		) {
			return null;
		}

		return { agentId, chain };
	}

	private async resolveInboxAddresses(senderInboxId: string): Promise<`0x${string}`[]> {
		const cached = this.inboxIdToAddress.get(senderInboxId);
		if (cached) {
			return [cached];
		}
		if (!this.client) return [];

		try {
			const states = await this.client.preferences.fetchInboxStates([senderInboxId]);
			const identifiers = states[0]?.identifiers ?? [];

			const addresses = identifiers
				.filter((identifier) => identifier.identifierKind === IDENTIFIER_KIND_ETHEREUM)
				.map((identifier) => identifier.identifier)
				.filter((identifier): identifier is `0x${string}` => isEthereumAddress(identifier))
				.map((identifier) => identifier.toLowerCase() as `0x${string}`);

			const unique = [...new Set(addresses)];
			if (unique.length > 0) {
				this.inboxIdToAddress.set(senderInboxId, unique[0]!);
			}

			return unique;
		} catch {
			return [];
		}
	}

	private async findContactByAddresses(addresses: `0x${string}`[]): Promise<Contact | null> {
		for (const address of addresses) {
			const contact = await this.trustStore.findByAgentAddress(address);
			if (contact) {
				return contact;
			}
		}
		return null;
	}

	private async sendJsonRpcReceipt(
		senderInboxId: string,
		id: ProtocolMessage["id"],
		requestId: string,
		ack: TransportAck,
	): Promise<void> {
		const dm = await this.findDmForSender(senderInboxId);
		if (!dm) {
			return;
		}

		await dm.sendText(
			JSON.stringify({
				jsonrpc: "2.0",
				id,
				result: {
					received: true,
					requestId,
					status: ack.status,
					receivedAt: nowISO(),
				},
			}),
		);
	}

	private async sendJsonRpcError(
		senderInboxId: string,
		id: ProtocolMessage["id"],
		code: number,
		message: string,
	): Promise<void> {
		const dm = await this.findDmForSender(senderInboxId);
		if (!dm) {
			return;
		}

		await dm.sendText(
			JSON.stringify({
				jsonrpc: "2.0",
				id,
				error: { code, message },
			}),
		);
	}

	private async resolveInboxId(address: `0x${string}`): Promise<string> {
		for (const [cachedInboxId, cachedAddr] of this.inboxIdToAddress) {
			if (cachedAddr.toLowerCase() === address.toLowerCase()) {
				return cachedInboxId;
			}
		}

		const inboxId = await this.client!.fetchInboxIdByIdentifier({
			identifier: address.toLowerCase(),
			identifierKind: IDENTIFIER_KIND_ETHEREUM,
		});
		if (!inboxId) {
			throw new TransportError(`Peer ${address} not registered on XMTP`);
		}

		this.inboxIdToAddress.set(inboxId, address.toLowerCase() as `0x${string}`);
		return inboxId;
	}

	private async findDmForSender(
		senderInboxId: string,
	): Promise<{ sendText: (text: string) => Promise<unknown> } | null> {
		if (!this.client) {
			return null;
		}

		try {
			return await this.client.conversations.createDm(senderInboxId);
		} catch {
			return null;
		}
	}

	private isDuplicateIncomingRequest(senderInboxId: string, request: ProtocolMessage): boolean {
		const now = Date.now();
		this.pruneProcessedIncomingRequests(now);
		return this.processedIncomingRequests.has(buildIncomingRequestKey(senderInboxId, request));
	}

	private markIncomingRequestProcessed(senderInboxId: string, request: ProtocolMessage): void {
		const now = Date.now();
		this.pruneProcessedIncomingRequests(now);
		this.processedIncomingRequests.set(buildIncomingRequestKey(senderInboxId, request), now);
	}

	private pruneProcessedIncomingRequests(now: number): void {
		for (const [key, timestamp] of this.processedIncomingRequests) {
			if (now - timestamp > INBOUND_REQUEST_DEDUPE_TTL_MS) {
				this.processedIncomingRequests.delete(key);
			}
		}

		if (this.processedIncomingRequests.size <= MAX_TRACKED_INBOUND_REQUESTS) {
			return;
		}

		const oldestEntries = [...this.processedIncomingRequests.entries()].sort(
			(left, right) => left[1] - right[1],
		);
		for (const [key] of oldestEntries.slice(
			0,
			this.processedIncomingRequests.size - MAX_TRACKED_INBOUND_REQUESTS,
		)) {
			this.processedIncomingRequests.delete(key);
		}
	}

	private async advanceCheckpoint(
		conversationId: string | undefined,
		sentAtNs: bigint | undefined,
		messageId: string | undefined,
	): Promise<void> {
		if (!this.syncState || !conversationId || sentAtNs === undefined || !messageId) {
			return;
		}
		await this.syncState.advance(conversationId, {
			sentAtNs,
			messageId,
		});
	}
}

function buildIncomingRequestKey(senderInboxId: string, request: ProtocolMessage): string {
	return `${senderInboxId}:${request.method}:${String(request.id)}`;
}

function buildMessageQuery(checkpoint: XmtpConversationCheckpoint | null): {
	sentAfterNs?: bigint;
	sortBy: number;
	direction: number;
} {
	if (!checkpoint) {
		return {
			sortBy: MESSAGE_SORT_BY_SENT_AT,
			direction: SORT_DIRECTION_ASCENDING,
		};
	}

	const floor = BigInt(checkpoint.lastSentAtNs);
	return {
		sentAfterNs: floor > 0n ? floor - 1n : floor,
		sortBy: MESSAGE_SORT_BY_SENT_AT,
		direction: SORT_DIRECTION_ASCENDING,
	};
}

function isMessageAlreadyCheckpointed(
	checkpoint: XmtpConversationCheckpoint | null,
	message: DecodedMessage,
): boolean {
	if (!checkpoint) {
		return false;
	}

	const checkpointNs = BigInt(checkpoint.lastSentAtNs);
	if (message.sentAtNs < checkpointNs) {
		return true;
	}
	if (message.sentAtNs > checkpointNs) {
		return false;
	}
	return checkpoint.lastMessageIds.includes(message.id);
}
