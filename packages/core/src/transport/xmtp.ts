import { Client } from "@xmtp/node-sdk";
import { hexToBytes, keccak256, toHex } from "viem";
import { TransportError, isEthereumAddress } from "../common/index.js";
import type { IAgentResolver } from "../identity/resolver.js";
import type { ConnectionRequestParams } from "../protocol/types.js";
import type { ITrustStore } from "../trust/trust-store.js";
import type { Contact } from "../trust/types.js";
import type { ProtocolMessage, ProtocolResponse, TransportProvider } from "./interface.js";
import type { TransportSendOptions } from "./types.js";
import { createXmtpSigner } from "./xmtp-signer.js";
import type { XmtpTransportConfig } from "./xmtp-types.js";

/** IdentifierKind.Ethereum from @xmtp/node-bindings (const enum, value inlined to avoid verbatimModuleSyntax issues) */
const IDENTIFIER_KIND_ETHEREUM = 0 as const;

const RECONNECT_DELAY_MS = 5_000;

interface PendingRequest {
	resolve: (response: ProtocolResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class XmtpTransport implements TransportProvider {
	private client: Client | null = null;
	private messageCallback?: (from: number, message: ProtocolMessage) => Promise<ProtocolResponse>;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private running = false;
	private streamCloser?: { return?: (value?: unknown) => Promise<unknown> };
	private readonly inboxIdToAddress = new Map<string, `0x${string}`>();
	private readonly agentResolver?: IAgentResolver;
	private readonly resolveCacheTtlMs: number;

	constructor(
		private readonly config: XmtpTransportConfig,
		private readonly trustStore: ITrustStore,
	) {
		this.agentResolver = config.agentResolver;
		this.resolveCacheTtlMs = config.resolveCacheTtlMs ?? 86_400_000;
	}

	async start(): Promise<void> {
		const signer = createXmtpSigner(this.config.privateKey);

		// Derive a deterministic encryption key from the agent's private key so
		// the XMTP database survives process restarts. Operators can override
		// with an explicit xmtpDbEncryptionKey config value.
		const dbEncryptionKey = this.config.dbEncryptionKey
			? hexToBytes(this.config.dbEncryptionKey)
			: hexToBytes(keccak256(toHex(`xmtp-db-encryption:${this.config.privateKey}`)));

		this.client = await Client.create(signer, {
			env: this.config.env ?? "production",
			dbEncryptionKey,
			...(this.config.dbPath
				? { dbPath: (inboxId: string) => `${this.config.dbPath}/${inboxId}.db3` }
				: {}),
		});

		this.running = true;

		// Pre-populate the inboxId → address cache from existing contacts
		// so incoming messages from known peers are recognized immediately.
		await this.populateInboxIdCache();

		// Start listening for messages with automatic reconnection.
		// Errors in the stream are handled internally and retried.
		this.listenWithReconnect();
	}

	async send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<ProtocolResponse> {
		if (!this.client) {
			throw new TransportError("XMTP client not started");
		}

		// Resolve peer address — either from options (direct addressing for
		// connection requests) or from the trust store.
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

		const messageId = String(message.id);
		const timeout = options?.timeout ?? this.config.defaultResponseTimeoutMs ?? 30_000;

		const responsePromise = new Promise<ProtocolResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(messageId);
				reject(new TransportError(`Response timeout for message ${messageId}`));
			}, timeout);

			this.pendingRequests.set(messageId, { resolve, reject, timer });
		});

		try {
			await dm.sendText(JSON.stringify(message));
		} catch (err) {
			// Clean up the pending entry if sending fails
			const pending = this.pendingRequests.get(messageId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(messageId);
			}
			throw err instanceof TransportError
				? err
				: new TransportError(
						`Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
					);
		}

		const response = await responsePromise;

		if (connectionId) {
			this.trustStore.touchContact(connectionId).catch(() => {});
		}

		return response;
	}

	onMessage(callback: (from: number, message: ProtocolMessage) => Promise<ProtocolResponse>): void {
		this.messageCallback = callback;
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

		this.client = null;
	}

	/**
	 * Pre-populates the inboxId → address cache from all existing contacts
	 * so that incoming messages from known peers are recognized without
	 * needing an outbound send() first.
	 */
	private async populateInboxIdCache(): Promise<void> {
		if (!this.client) return;
		const contacts = await this.trustStore.getContacts();
		for (const c of contacts) {
			try {
				await this.resolveInboxId(c.peerAgentAddress);
			} catch {
				// Skip contacts not registered on XMTP
			}
		}
	}

	/**
	 * Starts listening for messages with automatic reconnection on error.
	 * Network hiccups, XMTP node restarts, etc. will cause the stream to
	 * break and be re-established after a delay.
	 */
	private listenWithReconnect(): void {
		(async () => {
			while (this.running) {
				try {
					await this.listenForMessages();
				} catch {
					// Stream failed — will retry after delay
				}
				if (this.running) {
					await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
				}
			}
		})();
	}

	private async listenForMessages(): Promise<void> {
		if (!this.client) return;

		const stream = await this.client.conversations.streamAllDmMessages();
		this.streamCloser = stream;

		for await (const message of stream) {
			if (!this.running) break;
			this.processMessage(message).catch(() => {});
		}
	}

	private async processMessage(message: {
		senderInboxId: string;
		content: unknown;
		conversationId?: string;
	}): Promise<void> {
		if (message.senderInboxId === this.client?.inboxId) return;

		const content = typeof message.content === "string" ? message.content : null;
		if (!content) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			return;
		}

		if (typeof parsed !== "object" || parsed === null) return;
		const msg = parsed as Record<string, unknown>;
		if (msg.jsonrpc !== "2.0") return;

		if ("result" in msg || "error" in msg) {
			const msgId = String(msg.id);
			const pending = this.pendingRequests.get(msgId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(msgId);
				pending.resolve(msg as unknown as ProtocolResponse);
			}
		} else if ("method" in msg) {
			await this.handleIncomingRequest(message, msg as unknown as ProtocolMessage);
		}
	}

	private async handleIncomingRequest(
		rawMessage: { senderInboxId: string; conversationId?: string },
		request: ProtocolMessage,
	): Promise<void> {
		if (!this.messageCallback || !this.client) return;

		const senderAddresses = await this.resolveInboxAddresses(rawMessage.senderInboxId);
		const senderContact = await this.findContactByAddresses(senderAddresses);

		let senderId: number;

		if (senderContact) {
			if (senderContact.status !== "active") {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					request.id,
					-32003,
					"Sender connection is not active",
				);
				return;
			}
			senderId = senderContact.peerAgentId;
		} else if (request.method === "connection/request") {
			const params = request.params as ConnectionRequestParams | undefined;
			const claimedAgentId = params?.from?.agentId;
			const claimedChain = params?.from?.chain;

			if (
				typeof claimedAgentId !== "number" ||
				claimedAgentId < 0 ||
				typeof claimedChain !== "string" ||
				!claimedChain
			) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					request.id,
					-32001,
					"Invalid bootstrap sender identity",
				);
				return;
			}

			if (!this.agentResolver) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					request.id,
					-32001,
					"Bootstrap sender verification unavailable",
				);
				return;
			}

			const resolved = await this.agentResolver
				.resolveWithCache(claimedAgentId, claimedChain, this.resolveCacheTtlMs)
				.catch(() => null);
			if (!resolved) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					request.id,
					-32001,
					"Failed to resolve bootstrap sender identity",
				);
				return;
			}

			const expectedSenderAddress = resolved.agentAddress.toLowerCase();
			const verified = senderAddresses.some(
				(address) => address.toLowerCase() === expectedSenderAddress,
			);

			if (!verified) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					request.id,
					-32001,
					"Sender identity verification failed",
				);
				return;
			}

			this.inboxIdToAddress.set(rawMessage.senderInboxId, expectedSenderAddress as `0x${string}`);
			senderId = claimedAgentId;
		} else {
			await this.sendJsonRpcError(rawMessage.senderInboxId, request.id, -32001, "Unknown sender");
			return;
		}

		let response: ProtocolResponse;
		try {
			response = await this.messageCallback(senderId, request);
		} catch {
			response = {
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32603, message: "Internal error" },
			};
		}

		const dm = await this.findDmForSender(rawMessage.senderInboxId);
		if (dm) {
			await dm.sendText(JSON.stringify(response));
		}
	}

	/**
	 * Resolves Ethereum addresses currently authorized for the sender inbox.
	 * Uses cache first, then refreshes from XMTP network state.
	 */
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

	private async sendJsonRpcError(
		senderInboxId: string,
		id: ProtocolMessage["id"],
		code: number,
		message: string,
	): Promise<void> {
		const dm = await this.findDmForSender(senderInboxId);
		if (!dm) return;

		const errorResponse: ProtocolResponse = {
			jsonrpc: "2.0",
			id,
			error: { code, message },
		};
		await dm.sendText(JSON.stringify(errorResponse));
	}

	private async resolveInboxId(address: `0x${string}`): Promise<string> {
		// Check if we already have this address cached (by value, not by key)
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
		// Always store the normalized (lowercase) address
		this.inboxIdToAddress.set(inboxId, address.toLowerCase() as `0x${string}`);
		return inboxId;
	}

	private async findDmForSender(
		senderInboxId: string,
	): Promise<{ sendText: (text: string) => Promise<unknown> } | null> {
		if (!this.client) return null;
		try {
			return await this.client.conversations.createDm(senderInboxId);
		} catch {
			return null;
		}
	}
}
