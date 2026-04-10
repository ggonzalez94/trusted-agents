/**
 * Sync ordering invariant test — spec §3.3
 *
 * Per-conversation XMTP messages must be processed in delivery order during
 * syncOnce(). In practice this means a connection/result that arrives before
 * a message/send in the same sync batch must be fully applied to the trust
 * store before the message/send handler runs. If the two were processed in
 * parallel the message/send would be rejected as coming from an unknown sender
 * because the contact would still be "connecting" at the time of the check.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import { generateNonce } from "../../../src/common/index.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import { buildConnectionResult } from "../../../src/connection/index.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { ConversationMessage } from "../../../src/conversation/types.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { createEmptyPermissionState } from "../../../src/permissions/types.js";
import { createJsonRpcRequest } from "../../../src/protocol/messages.js";
import { MESSAGE_SEND } from "../../../src/protocol/methods.js";
import { FileRequestJournal } from "../../../src/runtime/request-journal.js";
import { TapMessagingService } from "../../../src/runtime/service.js";
import type {
	InboundRequestEnvelope,
	InboundResultEnvelope,
	ProtocolMessage,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
	TransportReconcileResult,
} from "../../../src/transport/interface.js";
import type { TransportSendOptions } from "../../../src/transport/types.js";
import type { ITrustStore } from "../../../src/trust/trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import { ALICE, BOB_SIGNING_PROVIDER } from "../../fixtures/test-keys.js";
import { useTempDirs } from "../../helpers/temp-dir.js";

const { track: trackTempDir } = useTempDirs();

// ---------------------------------------------------------------------------
// Agent fixture constants (Alice is agentId 1, Bob is agentId 10)
// ---------------------------------------------------------------------------

const ALICE_AGENT_ID = 1;
const ALICE_CHAIN = "eip155:8453";
const ALICE_INBOX_ID = "alice-inbox-id";

const BOB_AGENT_ID = 10;
const BOB_CHAIN = "eip155:8453";

// ---------------------------------------------------------------------------
// OrderedInboundTransport
//
// Delivers queued inbound messages in strict insertion order during reconcile(),
// awaiting each handler before dispatching the next. This makes the ordering
// invariant observable: if the service were to process handlers in parallel the
// connection/result and the subsequent message/send would race, and the test
// would either fail or become non-deterministic.
// ---------------------------------------------------------------------------

type InboundEnvelope =
	| { kind: "result"; envelope: InboundResultEnvelope }
	| { kind: "request"; envelope: InboundRequestEnvelope };

class OrderedInboundTransport implements TransportProvider {
	public readonly sentMessages: Array<{
		peerId: number;
		message: ProtocolMessage;
		options?: TransportSendOptions;
	}> = [];

	private handlers: TransportHandlers = {};
	private readonly queue: InboundEnvelope[] = [];

	setHandlers(handlers: TransportHandlers): void {
		this.handlers = handlers;
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	async isReachable(): Promise<boolean> {
		return true;
	}

	async send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<TransportReceipt> {
		this.sentMessages.push({ peerId, message, ...(options ? { options } : {}) });
		return {
			received: true,
			requestId: String(message.id),
			status: "received",
			receivedAt: new Date().toISOString(),
		};
	}

	/** Queue an inbound result envelope (connection/result, action/result, …). */
	enqueueResult(envelope: InboundResultEnvelope): void {
		this.queue.push({ kind: "result", envelope });
	}

	/** Queue an inbound request envelope (message/send, action/request, …). */
	enqueueRequest(envelope: InboundRequestEnvelope): void {
		this.queue.push({ kind: "request", envelope });
	}

	/**
	 * Deliver queued messages IN ORDER, awaiting each handler to completion
	 * before moving to the next. This is the key property under test: the
	 * service must observe the side-effects of each message (e.g. contact
	 * transitioning from "connecting" → "active") before the next message
	 * handler is invoked.
	 */
	async reconcile(): Promise<TransportReconcileResult> {
		let processed = 0;
		while (this.queue.length > 0) {
			const item = this.queue.shift()!;
			if (item.kind === "result") {
				await this.handlers.onResult?.(item.envelope);
			} else {
				await this.handlers.onRequest?.(item.envelope);
			}
			processed += 1;
		}
		return { synced: true, processed };
	}
}

// ---------------------------------------------------------------------------
// Recording conversation logger
//
// Captures every logged message so assertions can confirm that an incoming
// message/send was accepted rather than silently dropped.
// ---------------------------------------------------------------------------

interface RecordedEntry {
	conversationId: string;
	message: ConversationMessage;
}

function createRecordingConversationLogger(): IConversationLogger & {
	entries: RecordedEntry[];
} {
	const entries: RecordedEntry[] = [];
	return {
		entries,
		async logMessage(conversationId, message) {
			entries.push({ conversationId, message });
		},
		async getConversation() {
			return null;
		},
		async listConversations() {
			return [];
		},
		async generateTranscript() {
			return "";
		},
	};
}

// ---------------------------------------------------------------------------
// In-memory trust store (same pattern as service.recovery.test.ts)
// ---------------------------------------------------------------------------

function cloneContact<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function createMemoryTrustStore(initialContacts: Contact[] = []): ITrustStore {
	const contacts = new Map(initialContacts.map((c) => [c.connectionId, cloneContact(c)]));
	return {
		getContacts: async () => [...contacts.values()].map((c) => cloneContact(c)),
		getContact: async (connectionId) => cloneContact(contacts.get(connectionId) ?? null),
		findByAgentAddress: async (address, chain) =>
			cloneContact(
				[...contacts.values()].find(
					(c) =>
						c.peerAgentAddress.toLowerCase() === address.toLowerCase() &&
						(chain === undefined || c.peerChain === chain),
				) ?? null,
			),
		findByAgentId: async (agentId, chain) =>
			cloneContact(
				[...contacts.values()].find((c) => c.peerAgentId === agentId && c.peerChain === chain) ??
					null,
			),
		addContact: async (contact) => {
			contacts.set(contact.connectionId, cloneContact(contact));
		},
		updateContact: async (connectionId, updates) => {
			const existing = contacts.get(connectionId);
			if (!existing) return;
			contacts.set(connectionId, cloneContact({ ...existing, ...updates }));
		},
		removeContact: async (connectionId) => {
			contacts.delete(connectionId);
		},
		touchContact: async (connectionId) => {
			const existing = contacts.get(connectionId);
			if (!existing) return;
			contacts.set(connectionId, {
				...cloneContact(existing),
				lastContactAt: new Date().toISOString(),
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Static resolver for Alice (seen from Bob's perspective)
// ---------------------------------------------------------------------------

const ALICE_RESOLVED: ResolvedAgent = {
	agentId: ALICE_AGENT_ID,
	chain: ALICE_CHAIN,
	ownerAddress: ALICE.address,
	agentAddress: ALICE.address,
	capabilities: ["chat"],
	registrationFile: {
		type: "eip-8004-registration-v1",
		name: "Alice",
		description: "Alice agent",
		services: [{ name: "xmtp", endpoint: ALICE.address }],
		trustedAgentProtocol: {
			version: "1.0",
			agentAddress: ALICE.address,
			capabilities: ["chat"],
		},
	},
	resolvedAt: new Date().toISOString(),
};

function createStaticResolver(agent: ResolvedAgent = ALICE_RESOLVED): IAgentResolver {
	return {
		resolve: async () => agent,
		resolveWithCache: async () => agent,
	};
}

// ---------------------------------------------------------------------------
// Bob's service factory
// ---------------------------------------------------------------------------

async function createBobService(options: {
	trustStore?: ITrustStore;
	transport?: OrderedInboundTransport;
	conversationLogger?: IConversationLogger;
}): Promise<{
	service: TapMessagingService;
	transport: OrderedInboundTransport;
	trustStore: ITrustStore;
}> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-sync-ordering-"));
	trackTempDir(dataDir);

	const config: TrustedAgentsConfig = {
		agentId: BOB_AGENT_ID,
		chain: BOB_CHAIN,
		ows: { wallet: "test-bob", apiKey: "ows_key_bob" },
		dataDir,
		chains: {},
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60_000,
		resolveCacheMaxEntries: 128,
	};

	const trustStore = options.trustStore ?? createMemoryTrustStore();
	const transport = options.transport ?? new OrderedInboundTransport();
	const requestJournal = new FileRequestJournal(dataDir);
	const appRegistry = new TapAppRegistry(dataDir);

	const service = new TapMessagingService(
		{
			config,
			signingProvider: BOB_SIGNING_PROVIDER,
			trustStore,
			resolver: createStaticResolver(),
			conversationLogger: options.conversationLogger ?? createRecordingConversationLogger(),
			requestJournal,
			transport,
			appRegistry,
		},
		{ ownerLabel: "tap:test-bob-ordering" },
	);

	return { service, transport, trustStore };
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/**
 * Build an inbound connection/result envelope from Alice, accepting a
 * previously-sent connection/request from Bob.
 */
function makeConnectionResultEnvelope(_connectionId: string): InboundResultEnvelope {
	const resultMessage = buildConnectionResult({
		requestId: generateNonce(), // correlates to Bob's outbound request; not load-bearing here
		from: { agentId: ALICE_AGENT_ID, chain: ALICE_CHAIN },
		status: "accepted",
		timestamp: new Date().toISOString(),
	});
	return {
		from: ALICE_AGENT_ID,
		senderInboxId: ALICE_INBOX_ID,
		message: resultMessage,
	};
}

/**
 * Build an inbound message/send envelope from Alice.
 * The connectionId must match the contact that Bob will have after the
 * connection/result activates it.
 */
function makeMessageSendEnvelope(connectionId: string, text: string): InboundRequestEnvelope {
	const message = createJsonRpcRequest(MESSAGE_SEND, {
		message: {
			messageId: generateNonce(),
			role: "user",
			parts: [{ kind: "text", text }],
			metadata: {
				trustedAgent: {
					connectionId,
					conversationId: `conv-${connectionId}`,
					scope: "general-chat",
					requiresHumanApproval: false,
				},
			},
		},
	});
	return {
		from: ALICE_AGENT_ID,
		senderInboxId: ALICE_INBOX_ID,
		message,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync ordering invariant (spec §3.3)", () => {
	it("processes connection/result before a subsequent message/send in the same sync pass", async () => {
		const now = new Date().toISOString();
		const connectionId = "conn-sync-ordering-001";

		// Pre-seed Bob's trust store with a "connecting" contact for Alice.
		// This simulates the state where Bob previously ran `tap connect` and
		// sent a connection/request but hasn't received Alice's result yet.
		const connectingContact: Contact = {
			connectionId,
			peerAgentId: ALICE_AGENT_ID,
			peerChain: ALICE_CHAIN,
			peerOwnerAddress: ALICE.address,
			peerDisplayName: "Alice",
			peerAgentAddress: ALICE.address,
			permissions: createEmptyPermissionState(now),
			establishedAt: now,
			lastContactAt: now,
			status: "connecting",
		};

		const trustStore = createMemoryTrustStore([connectingContact]);
		const transport = new OrderedInboundTransport();
		const conversationLogger = createRecordingConversationLogger();

		const { service } = await createBobService({ trustStore, transport, conversationLogger });

		// Queue two inbound messages from Alice in order:
		//   1. connection/result (status: "accepted") — must activate the contact
		//   2. message/send — must be accepted because contact is now active
		//
		// If the service were to process these in parallel, message/send would
		// race against connection/result and might be rejected because the
		// contact is still "connecting" at the point of the contact lookup.
		transport.enqueueResult(makeConnectionResultEnvelope(connectionId));
		transport.enqueueRequest(makeMessageSendEnvelope(connectionId, "hello while offline"));

		// Run a single sync pass. The transport's reconcile() delivers queued
		// messages serially (awaiting each before the next), so the ordering
		// invariant is observable.
		await service.syncOnce();

		// Assertion 1: Bob's contact for Alice is now "active".
		// If the connection/result was not processed first (or at all), this
		// would still be "connecting".
		const contact = await trustStore.findByAgentId(ALICE_AGENT_ID, ALICE_CHAIN);
		expect(contact?.status).toBe("active");

		// Assertion 2: The message/send was accepted and logged to the
		// conversation, NOT silently dropped as coming from an unknown/inactive sender.
		const incomingMessages = conversationLogger.entries.filter(
			(e) => e.message.direction === "incoming",
		);
		expect(incomingMessages.length).toBeGreaterThanOrEqual(1);
		const hasHelloMessage = incomingMessages.some((e) =>
			e.message.content.includes("hello while offline"),
		);
		expect(hasHelloMessage).toBe(true);
	});

	it("rejects a message/send from a completely unknown sender (no contact at all)", async () => {
		// Complementary negative test: without any prior contact record, a
		// message/send from an unknown sender must be rejected. This validates
		// the baseline that the service does not blindly accept messages from
		// arbitrary agents.
		const transport = new OrderedInboundTransport();
		const conversationLogger = createRecordingConversationLogger();

		// Start with an empty trust store — Alice has no contact record at all.
		const trustStore = createMemoryTrustStore([]);

		const { service } = await createBobService({ trustStore, transport, conversationLogger });

		// Queue a message/send from Alice with a connectionId that doesn't exist
		// in Bob's trust store.
		const unknownConnectionId = "conn-does-not-exist";
		transport.enqueueRequest(
			makeMessageSendEnvelope(unknownConnectionId, "this should be rejected"),
		);

		// syncOnce() propagates errors thrown by reconcile() — the unknown-sender
		// rejection is a ValidationError that surfaces to the caller.
		await expect(service.syncOnce()).rejects.toThrow();

		// No contact was created for Alice.
		const contact = await trustStore.findByAgentId(ALICE_AGENT_ID, ALICE_CHAIN);
		expect(contact).toBeNull();

		// No incoming messages logged — the message/send was rejected.
		const incomingMessages = conversationLogger.entries.filter(
			(e) => e.message.direction === "incoming",
		);
		expect(incomingMessages.length).toBe(0);
	});
});
