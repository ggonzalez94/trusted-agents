/**
 * connection/revoke tests (spec §3.4).
 *
 * Covers:
 * - revokeConnection: persists an outbound journal entry and sends the wire message
 * - revokeConnection: leaves a pending journal entry and does NOT throw on send failure
 * - processConnectionRevoke: removes the peer's contact when received inbound
 * - processConnectionRevoke: is idempotent when the contact does not exist
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import { TransportError } from "../../../src/common/errors.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import { buildConnectionRevoke } from "../../../src/connection/handshake.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { createEmptyPermissionState } from "../../../src/permissions/types.js";
import { CONNECTION_REVOKE } from "../../../src/protocol/methods.js";
import { FileRequestJournal as FileRequestJournalImpl } from "../../../src/runtime/request-journal.js";
import type { FileRequestJournal } from "../../../src/runtime/request-journal.js";
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
import { ALICE_SIGNING_PROVIDER, BOB } from "../../fixtures/test-keys.js";
import { useTempDirs } from "../../helpers/temp-dir.js";

const { track: trackTempDir } = useTempDirs();

// ──────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────

const PEER_AGENT: ResolvedAgent = {
	agentId: 42,
	chain: "eip155:8453",
	ownerAddress: BOB.address,
	agentAddress: BOB.address,
	capabilities: ["chat"],
	registrationFile: {
		type: "eip-8004-registration-v1",
		name: "Bob",
		description: "Peer agent",
		services: [{ name: "xmtp", endpoint: BOB.address }],
		trustedAgentProtocol: {
			version: "1.0",
			agentAddress: BOB.address,
			capabilities: ["chat"],
		},
	},
	resolvedAt: "2026-04-10T00:00:00.000Z",
};

function makeActiveContact(): Contact {
	return {
		connectionId: "conn-test-42",
		peerAgentId: PEER_AGENT.agentId,
		peerChain: PEER_AGENT.chain,
		peerOwnerAddress: PEER_AGENT.ownerAddress,
		peerDisplayName: PEER_AGENT.registrationFile.name,
		peerAgentAddress: PEER_AGENT.agentAddress,
		permissions: createEmptyPermissionState("2026-04-10T00:00:00.000Z"),
		establishedAt: "2026-04-10T00:00:00.000Z",
		lastContactAt: "2026-04-10T00:00:00.000Z",
		status: "active",
	};
}

// ──────────────────────────────────────────────────────────────
// Transport stubs
// ──────────────────────────────────────────────────────────────

class FakeTransport implements TransportProvider {
	public readonly sentMessages: Array<{
		peerId: number;
		message: ProtocolMessage;
		options?: TransportSendOptions;
	}> = [];
	public handlers: TransportHandlers = {};

	constructor(private readonly sendError?: Error) {}

	setHandlers(handlers: TransportHandlers): void {
		this.handlers = handlers;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async isReachable(): Promise<boolean> {
		return true;
	}
	async reconcile() {
		return { synced: true as const, processed: 0 };
	}
	async send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<TransportReceipt> {
		this.sentMessages.push({ peerId, message, ...(options ? { options } : {}) });
		if (this.sendError) {
			throw this.sendError;
		}
		return {
			received: true,
			requestId: String(message.id),
			status: options?.waitForAck === false ? "published" : "received",
			receivedAt: "2026-04-10T00:00:00.000Z",
		};
	}
}

// ──────────────────────────────────────────────────────────────
// Memory trust store
// ──────────────────────────────────────────────────────────────

function cloneContact<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function createMemoryTrustStore(initialContacts: Contact[] = []): ITrustStore {
	const contacts = new Map(
		initialContacts.map((contact) => [contact.connectionId, cloneContact(contact)]),
	);
	return {
		getContacts: async () => [...contacts.values()].map((c) => cloneContact(c)),
		getContact: async (id: string) => cloneContact(contacts.get(id) ?? null),
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
			contacts.set(
				connectionId,
				cloneContact({ ...existing, lastContactAt: new Date().toISOString() }),
			);
		},
	};
}

// ──────────────────────────────────────────────────────────────
// Static resolver
// ──────────────────────────────────────────────────────────────

function createStaticResolver(): IAgentResolver {
	return {
		resolve: async () => PEER_AGENT,
		resolveWithCache: async () => PEER_AGENT,
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

// ──────────────────────────────────────────────────────────────
// Service factory
// ──────────────────────────────────────────────────────────────

async function createService(
	dependencies: {
		trustStore?: ITrustStore;
		transport?: FakeTransport;
	} = {},
): Promise<{
	service: TapMessagingService;
	transport: FakeTransport;
	requestJournal: FileRequestJournal;
	trustStore: ITrustStore;
}> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-revoke-test-"));
	trackTempDir(dataDir);

	const config: TrustedAgentsConfig = {
		agentId: 1,
		chain: "eip155:8453",
		ows: { wallet: "test", apiKey: "ows_key_test" },
		dataDir,
		chains: {},
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60_000,
		resolveCacheMaxEntries: 128,
	};

	const trustStore = dependencies.trustStore ?? createMemoryTrustStore();
	const requestJournal = new FileRequestJournalImpl(dataDir);
	const transport = dependencies.transport ?? new FakeTransport();
	const appRegistry = new TapAppRegistry(dataDir);

	const service = new TapMessagingService(
		{
			config,
			signingProvider: ALICE_SIGNING_PROVIDER,
			trustStore,
			resolver: createStaticResolver(),
			conversationLogger: createNoopConversationLogger(),
			requestJournal,
			transport,
			appRegistry,
		},
		{ ownerLabel: "tap:revoke-test" },
	);

	return { service, transport, requestJournal, trustStore };
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe("connection revoke (spec §3.4)", () => {
	it("revokeConnection persists a completed outbound journal entry and sends the wire message", async () => {
		const contact = makeActiveContact();
		const trustStore = createMemoryTrustStore([contact]);
		const { service, transport, requestJournal } = await createService({ trustStore });

		await service.revokeConnection(contact);

		// Verify the wire message was sent
		const sent = transport.sentMessages.filter((m) => m.message.method === CONNECTION_REVOKE);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.peerId).toBe(contact.peerAgentId);

		// Verify the journal entry was completed
		const entries = await requestJournal.list("outbound");
		const revokeEntry = entries.find((e) => e.method === CONNECTION_REVOKE);
		expect(revokeEntry).toBeDefined();
		expect(revokeEntry?.status).toBe("completed");
		expect(revokeEntry?.direction).toBe("outbound");
		expect(revokeEntry?.kind).toBe("request");
		expect(revokeEntry?.peerAgentId).toBe(contact.peerAgentId);
	});

	it("revokeConnection leaves a pending journal entry and does NOT throw when the send fails", async () => {
		const contact = makeActiveContact();
		const failingTransport = new FakeTransport(new TransportError("network error"));
		const { service, requestJournal } = await createService({ transport: failingTransport });

		// Must not throw — local delete should still proceed
		await expect(service.revokeConnection(contact)).resolves.toBeUndefined();

		// Journal entry should remain pending
		const entries = await requestJournal.list("outbound");
		const revokeEntry = entries.find((e) => e.method === CONNECTION_REVOKE);
		expect(revokeEntry).toBeDefined();
		expect(revokeEntry?.status).toBe("pending");
	});

	it("revokeConnection optionally includes a reason in the wire params", async () => {
		const contact = makeActiveContact();
		const { service, transport } = await createService();

		await service.revokeConnection(contact, "user requested removal");

		const sent = transport.sentMessages.find((m) => m.message.method === CONNECTION_REVOKE);
		expect(sent).toBeDefined();
		const params = sent?.message.params as { reason?: string } | undefined;
		expect(params?.reason).toBe("user requested removal");
	});

	it("processConnectionRevoke removes an existing contact when received inbound", async () => {
		const contact = makeActiveContact();
		const trustStore = createMemoryTrustStore([contact]);
		const { service, transport } = await createService({ trustStore });

		// Start the service so the transport handlers are registered
		await service.start();

		// Drive the inbound revoke through the transport handler
		const revokeMessage = buildConnectionRevoke({
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			timestamp: "2026-04-10T00:00:00.000Z",
		});

		await transport.handlers.onRequest?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "inbox-bob",
			message: revokeMessage,
		});

		// Contact should be gone
		const after = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(after).toBeNull();

		await service.stop();
	});

	it("processConnectionRevoke marks the journal entry completed after removing the contact", async () => {
		const contact = makeActiveContact();
		const trustStore = createMemoryTrustStore([contact]);
		const { service, transport, requestJournal } = await createService({ trustStore });

		// Start the service so the transport handlers are registered
		await service.start();

		const revokeMessage = buildConnectionRevoke({
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			timestamp: "2026-04-10T00:00:00.000Z",
		});

		await transport.handlers.onRequest?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "inbox-bob",
			message: revokeMessage,
		});

		// Journal entry for the inbound revoke should be completed
		const entries = await requestJournal.list("inbound");
		const revokeEntry = entries.find((e) => e.method === CONNECTION_REVOKE);
		expect(revokeEntry?.status).toBe("completed");

		await service.stop();
	});

	it("stores revokeDelivery metadata so the reconciliation loop can retry on the next run", async () => {
		// Regression for Codex adversarial review finding #3: before this fix,
		// a failed initial revoke send left a pending journal entry with no
		// delivery metadata, and the reconciliation loop only scanned
		// connection/result entries — so the revoke was never retried and the
		// peer stayed connected forever while the CLI reported success.
		const contact = makeActiveContact();
		const failingTransport = new FakeTransport(new TransportError("network hiccup"));
		const { service, requestJournal } = await createService({ transport: failingTransport });

		await service.revokeConnection(contact, "user request");

		const entries = await requestJournal.list("outbound");
		const revokeEntry = entries.find((e) => e.method === CONNECTION_REVOKE);
		expect(revokeEntry).toBeDefined();
		expect(revokeEntry?.status).toBe("pending");

		// Metadata must carry enough information to rebuild the wire message.
		const metadata = revokeEntry?.metadata as { revokeDelivery?: Record<string, unknown> };
		expect(metadata?.revokeDelivery).toBeDefined();
		expect(metadata.revokeDelivery?.peerAgentId).toBe(contact.peerAgentId);
		expect(metadata.revokeDelivery?.peerChain).toBe(contact.peerChain);
		expect(metadata.revokeDelivery?.peerAddress).toBe(contact.peerAgentAddress);
		expect(metadata.revokeDelivery?.peerDisplayName).toBe(contact.peerDisplayName);
		expect(metadata.revokeDelivery?.reason).toBe("user request");
	});

	it("retries a pending connection/revoke on a subsequent sync and marks it completed on success", async () => {
		// Regression for Codex adversarial review finding #3: the reconciliation
		// loop now drains pending connection/revoke entries. First send fails,
		// entry stays pending; subsequent sync retries with a healthy transport
		// and completes the entry.
		const contact = makeActiveContact();

		// Flakey transport that fails the first send, then succeeds afterwards.
		class FlakeyTransport implements TransportProvider {
			public readonly sentMessages: Array<{
				peerId: number;
				message: ProtocolMessage;
			}> = [];
			public handlers: TransportHandlers = {};
			private failsRemaining = 1;

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
				_options?: TransportSendOptions,
			): Promise<TransportReceipt> {
				if (this.failsRemaining > 0) {
					this.failsRemaining -= 1;
					throw new TransportError("initial send failure");
				}
				this.sentMessages.push({ peerId, message });
				return {
					received: true,
					requestId: String(message.id),
					status: "accepted",
					receivedAt: new Date().toISOString(),
				};
			}
			async reconcile(): Promise<void> {}
		}

		const transport = new FlakeyTransport();
		const { service, requestJournal } = await createService({ transport });

		// Initial call fails to send but the entry is persisted as pending with
		// revokeDelivery metadata.
		await service.revokeConnection(contact);
		let entries = await requestJournal.list("outbound");
		let revokeEntry = entries.find((e) => e.method === CONNECTION_REVOKE);
		expect(revokeEntry?.status).toBe("pending");
		expect(transport.sentMessages.length).toBe(0);

		// Next sync cycle: the reconciliation loop picks up the pending revoke,
		// re-sends (now succeeds), and marks it completed.
		await service.syncOnce();

		entries = await requestJournal.list("outbound");
		revokeEntry = entries.find((e) => e.method === CONNECTION_REVOKE);
		expect(revokeEntry?.status).toBe("completed");
		expect(transport.sentMessages.length).toBe(1);
		expect(transport.sentMessages[0]?.message.method).toBe(CONNECTION_REVOKE);
	});
});
