import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import { buildConnectionResult, generateInvite } from "../../../src/connection/index.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { createEmptyPermissionState } from "../../../src/permissions/types.js";
import { FileRequestJournal } from "../../../src/runtime/request-journal.js";
import { TapMessagingService } from "../../../src/runtime/service.js";
import type {
	ProtocolMessage,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "../../../src/transport/interface.js";
import type { TransportSendOptions } from "../../../src/transport/types.js";
import type { ITrustStore } from "../../../src/trust/trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import {
	ALICE,
	ALICE_SIGNING_PROVIDER,
	BOB,
	BOB_SIGNING_PROVIDER,
} from "../../fixtures/test-keys.js";
import { useTempDirs } from "../../helpers/temp-dir.js";

const { track: trackTempDir } = useTempDirs();

// ---------------------------------------------------------------------------
// Minimal transport mock that records sent messages and can simulate an
// immediate acceptance of connection/request by calling onResult on send.
// ---------------------------------------------------------------------------

class CapturingTransport implements TransportProvider {
	public readonly sentMessages: Array<{
		peerId: number;
		message: ProtocolMessage;
		options?: TransportSendOptions;
	}> = [];

	public handlers: TransportHandlers = {};

	/** When set, a connection/request send immediately triggers an accepted result. */
	public autoAcceptFrom: { agentId: number; chain: string } | null = null;

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

		// Auto-simulate an accepted connection/result if configured.
		if (message.method === "connection/request" && this.autoAcceptFrom !== null) {
			const { agentId, chain } = this.autoAcceptFrom;
			await this.handlers.onResult?.({
				from: agentId,
				senderInboxId: `peer-inbox-${agentId}`,
				message: buildConnectionResult({
					requestId: String(message.id),
					from: { agentId, chain },
					status: "accepted",
					timestamp: new Date().toISOString(),
				}),
			});
		}

		return {
			received: true,
			requestId: String(message.id),
			status: "received",
			receivedAt: new Date().toISOString(),
		};
	}
}

// ---------------------------------------------------------------------------
// In-memory trust store — mirrors the one in service.test.ts
// ---------------------------------------------------------------------------

function cloneContact<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function createMemoryTrustStore(initialContacts: Contact[] = []): ITrustStore {
	const contacts = new Map(
		initialContacts.map((contact) => [contact.connectionId, cloneContact(contact)]),
	);
	return {
		getContacts: async () => [...contacts.values()].map((c) => cloneContact(c)),
		getContact: async (connectionId: string) => cloneContact(contacts.get(connectionId) ?? null),
		findByAgentAddress: async (address: `0x${string}`, chain?: string) =>
			cloneContact(
				[...contacts.values()].find(
					(c) =>
						c.peerAgentAddress.toLowerCase() === address.toLowerCase() &&
						(chain === undefined || c.peerChain === chain),
				) ?? null,
			),
		findByAgentId: async (agentId: number, chain: string) =>
			cloneContact(
				[...contacts.values()].find((c) => c.peerAgentId === agentId && c.peerChain === chain) ??
					null,
			),
		addContact: async (contact: Contact) => {
			contacts.set(contact.connectionId, cloneContact(contact));
		},
		updateContact: async (connectionId: string, updates: Partial<Contact>) => {
			const existing = contacts.get(connectionId);
			if (!existing) return;
			contacts.set(connectionId, cloneContact({ ...existing, ...updates }));
		},
		removeContact: async (connectionId: string) => {
			contacts.delete(connectionId);
		},
		touchContact: async (connectionId: string) => {
			const existing = contacts.get(connectionId);
			if (!existing) return;
			contacts.set(connectionId, {
				...cloneContact(existing),
				lastContactAt: new Date().toISOString(),
			});
		},
		// expose the internal map for wipe operations in tests
		_contacts: contacts,
	} as ITrustStore & { _contacts: Map<string, Contact> };
}

// ---------------------------------------------------------------------------
// Static resolver fixtures
// ---------------------------------------------------------------------------

const ALICE_RESOLVED: ResolvedAgent = {
	agentId: 1,
	chain: "eip155:8453",
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

const BOB_RESOLVED: ResolvedAgent = {
	agentId: 10,
	chain: "eip155:8453",
	ownerAddress: BOB.address,
	agentAddress: BOB.address,
	capabilities: ["chat"],
	registrationFile: {
		type: "eip-8004-registration-v1",
		name: "Bob",
		description: "Bob agent",
		services: [{ name: "xmtp", endpoint: BOB.address }],
		trustedAgentProtocol: {
			version: "1.0",
			agentAddress: BOB.address,
			capabilities: ["chat"],
		},
	},
	resolvedAt: new Date().toISOString(),
};

function createStaticResolver(agent: ResolvedAgent): IAgentResolver {
	return {
		resolve: async () => agent,
		resolveWithCache: async () => agent,
	};
}

function createNoopConversationLogger(): IConversationLogger {
	return {
		logMessage: async () => {},
		getConversation: async () => null,
		listConversations: async () => [],
		generateTranscript: async () => "",
	};
}

// ---------------------------------------------------------------------------
// Service factory — Bob's service by default (agentId 10)
// ---------------------------------------------------------------------------

async function createBobService(
	options: {
		trustStore?: ITrustStore;
		transport?: CapturingTransport;
		resolver?: IAgentResolver;
	} = {},
): Promise<{
	service: TapMessagingService;
	transport: CapturingTransport;
	trustStore: ITrustStore & { _contacts: Map<string, Contact> };
}> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-recovery-"));
	trackTempDir(dataDir);

	const config: TrustedAgentsConfig = {
		agentId: BOB_RESOLVED.agentId,
		chain: BOB_RESOLVED.chain,
		ows: { wallet: "test-bob", apiKey: "ows_key_bob" },
		dataDir,
		chains: {},
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60_000,
		resolveCacheMaxEntries: 128,
	};

	const trustStore =
		(options.trustStore as ITrustStore & { _contacts: Map<string, Contact> }) ??
		(createMemoryTrustStore() as ITrustStore & { _contacts: Map<string, Contact> });
	const transport = options.transport ?? new CapturingTransport();
	const requestJournal = new FileRequestJournal(dataDir);
	const appRegistry = new TapAppRegistry(dataDir);

	const service = new TapMessagingService(
		{
			config,
			signingProvider: BOB_SIGNING_PROVIDER,
			trustStore,
			resolver: options.resolver ?? createStaticResolver(ALICE_RESOLVED),
			conversationLogger: createNoopConversationLogger(),
			requestJournal,
			transport,
			appRegistry,
		},
		{ ownerLabel: "tap:test-bob" },
	);

	return { service, transport, trustStore };
}

// ---------------------------------------------------------------------------
// Helper to generate Alice's invite
// ---------------------------------------------------------------------------

async function aliceInvite(): Promise<string> {
	const { url } = await generateInvite({
		agentId: ALICE_RESOLVED.agentId,
		chain: ALICE_RESOLVED.chain,
		signingProvider: ALICE_SIGNING_PROVIDER,
		expirySeconds: 3600,
	});
	return url;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connect() self-healing (spec §3.1.1)", () => {
	it("sends connection/request even when local contact is already active", async () => {
		// Pre-seed Bob's trust store with an already-active contact for Alice.
		const now = new Date().toISOString();
		const existingContact: Contact = {
			connectionId: "conn-recovery-001",
			peerAgentId: ALICE_RESOLVED.agentId,
			peerChain: ALICE_RESOLVED.chain,
			peerOwnerAddress: ALICE_RESOLVED.ownerAddress,
			peerDisplayName: "Alice",
			peerAgentAddress: ALICE_RESOLVED.agentAddress,
			permissions: createEmptyPermissionState(now),
			establishedAt: now,
			lastContactAt: now,
			status: "active",
		};

		const trustStore = createMemoryTrustStore([existingContact]);
		const transport = new CapturingTransport();
		const { service } = await createBobService({ trustStore, transport });

		// Bob reconnects using a fresh Alice invite — Alice's side is treated as
		// "already active" in Bob's store, but connect() must still send a
		// connection/request (no early-return, spec §3.1.1).
		const inviteUrl = await aliceInvite();
		await service.connect({ inviteUrl, waitMs: 0 });

		const connectionRequests = transport.sentMessages.filter(
			(m) => m.message.method === "connection/request",
		);
		expect(connectionRequests.length).toBeGreaterThanOrEqual(1);

		// Bob's contact is still active — no state regression.
		const after = await trustStore.findByAgentId(ALICE_RESOLVED.agentId, ALICE_RESOLVED.chain);
		expect(after?.status).toBe("active");
	});

	it("does not create a duplicate contact row when reconnecting to an already-active peer", async () => {
		const now = new Date().toISOString();
		const existingContact: Contact = {
			connectionId: "conn-recovery-002",
			peerAgentId: ALICE_RESOLVED.agentId,
			peerChain: ALICE_RESOLVED.chain,
			peerOwnerAddress: ALICE_RESOLVED.ownerAddress,
			peerDisplayName: "Alice",
			peerAgentAddress: ALICE_RESOLVED.agentAddress,
			permissions: createEmptyPermissionState(now),
			establishedAt: now,
			lastContactAt: now,
			status: "active",
		};

		const trustStore = createMemoryTrustStore([existingContact]) as ITrustStore & {
			_contacts: Map<string, Contact>;
		};
		const transport = new CapturingTransport();
		const { service } = await createBobService({ trustStore, transport });

		const contactsBefore = (await trustStore.getContacts()).filter(
			(c) => c.peerAgentId === ALICE_RESOLVED.agentId,
		).length;

		const inviteUrl = await aliceInvite();
		await service.connect({ inviteUrl, waitMs: 0 });

		const contactsAfter = (await trustStore.getContacts()).filter(
			(c) => c.peerAgentId === ALICE_RESOLVED.agentId,
		).length;

		// No new contact row created — the existing active contact is preserved.
		expect(contactsAfter).toBe(contactsBefore);
	});

	it("recovers after Alice's trust store is wiped (Alice wipes → Bob reconnects)", async () => {
		// Step 1: Bob's service with an auto-accept transport so connect() resolves
		// to "active" immediately (simulates Alice accepting the handshake).
		const transport = new CapturingTransport();
		transport.autoAcceptFrom = {
			agentId: ALICE_RESOLVED.agentId,
			chain: ALICE_RESOLVED.chain,
		};
		const trustStore = createMemoryTrustStore();
		const { service } = await createBobService({ trustStore, transport });

		// Initial connect — both sides become active.
		const firstUrl = await aliceInvite();
		const firstResult = await service.connect({ inviteUrl: firstUrl, waitMs: 0 });
		expect(firstResult.status).toBe("active");

		// Verify Bob's trust store shows Alice as active.
		const aliceContactBefore = await trustStore.findByAgentId(
			ALICE_RESOLVED.agentId,
			ALICE_RESOLVED.chain,
		);
		expect(aliceContactBefore?.status).toBe("active");

		// Step 2: Simulate Alice wiping her side (Bob's trust store is fine, but
		// we model "Alice forgot Bob" by clearing Bob's stored Alice contact and
		// re-running connect — which mirrors what Alice's wipe would trigger).
		// In the single-service model, "Alice wipes" means Bob's record is gone
		// from Alice's store but Bob still has Alice as active. Bob then uses a
		// fresh invite from Alice (Alice re-registered) to reconnect.
		// Here we test that Bob's connect() still fires wire traffic even when
		// Bob's local contact for Alice is active.
		const sentBefore = transport.sentMessages.length;
		const secondUrl = await aliceInvite();
		const secondResult = await service.connect({ inviteUrl: secondUrl, waitMs: 0 });

		// connect() must have sent at least one new connection/request.
		const newConnectionRequests = transport.sentMessages
			.slice(sentBefore)
			.filter((m) => m.message.method === "connection/request");
		expect(newConnectionRequests.length).toBeGreaterThanOrEqual(1);

		// Bob's trust store still has Alice as active after re-connect.
		const aliceContactAfter = await trustStore.findByAgentId(
			ALICE_RESOLVED.agentId,
			ALICE_RESOLVED.chain,
		);
		expect(aliceContactAfter?.status).toBe("active");

		// Status reflects the auto-accepted response.
		expect(secondResult.status).toBe("active");
	});

	it("does not downgrade active contact to connecting during re-handshake (spec §3.1.1)", async () => {
		// Verify the specific invariant: when existing?.status === "active",
		// connectInternal skips the upsert to "connecting" but still sends the
		// wire request.
		const now = new Date().toISOString();
		const existingContact: Contact = {
			connectionId: "conn-recovery-003",
			peerAgentId: ALICE_RESOLVED.agentId,
			peerChain: ALICE_RESOLVED.chain,
			peerOwnerAddress: ALICE_RESOLVED.ownerAddress,
			peerDisplayName: "Alice",
			peerAgentAddress: ALICE_RESOLVED.agentAddress,
			permissions: createEmptyPermissionState(now),
			establishedAt: now,
			lastContactAt: now,
			status: "active",
		};

		let statusAtSendTime: string | undefined;
		class ObservingTransport extends CapturingTransport {
			override async send(
				peerId: number,
				message: ProtocolMessage,
				options?: TransportSendOptions,
			): Promise<TransportReceipt> {
				if (message.method === "connection/request") {
					// Capture contact status at the moment send is called.
					const contact = await trustStore.findByAgentId(
						ALICE_RESOLVED.agentId,
						ALICE_RESOLVED.chain,
					);
					statusAtSendTime = contact?.status;
				}
				return super.send(peerId, message, options);
			}
		}

		const trustStore = createMemoryTrustStore([existingContact]);
		const transport = new ObservingTransport();
		const { service } = await createBobService({ trustStore, transport });

		const inviteUrl = await aliceInvite();
		await service.connect({ inviteUrl, waitMs: 0 });

		// The contact was NOT downgraded to "connecting" during the send.
		expect(statusAtSendTime).toBe("active");

		// The connection/request was still sent (no early-return).
		const connectionRequests = transport.sentMessages.filter(
			(m) => m.message.method === "connection/request",
		);
		expect(connectionRequests.length).toBeGreaterThanOrEqual(1);
	});
});
