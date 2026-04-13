/**
 * connect() synchronous waiting tests (spec §3.1 + Task 4.2).
 *
 * Covers:
 * - Returns active when connection/result arrives within waitMs
 * - Returns pending when waitMs expires before result
 * - waitMs=0 returns immediately (fire-and-forget)
 * - Throws ValidationError when peer explicitly rejects
 * - Wire-level idempotency: re-running connect() reuses an existing non-terminal
 *   outbound journal entry
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import { ValidationError } from "../../../src/common/errors.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import { buildConnectionResult } from "../../../src/connection/handshake.js";
import { generateInvite } from "../../../src/connection/invite.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { CONNECTION_REQUEST } from "../../../src/protocol/methods.js";
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
import { ALICE_SIGNING_PROVIDER, BOB, BOB_SIGNING_PROVIDER } from "../../fixtures/test-keys.js";
import { useTempDirs } from "../../helpers/temp-dir.js";

const { track: trackTempDir } = useTempDirs();

// ──────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────

const PEER_AGENT: ResolvedAgent = {
	agentId: 10,
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
	resolvedAt: "2026-03-07T00:00:00.000Z",
};

// ──────────────────────────────────────────────────────────────
// Helpers
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

function createStaticResolver(agent: ResolvedAgent = PEER_AGENT): IAgentResolver {
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

/**
 * A transport that records sent messages and exposes handlers for manual result
 * delivery. Default: send always succeeds.
 */
class ManualTransport implements TransportProvider {
	public readonly sentMessages: Array<{
		peerId: number;
		message: ProtocolMessage;
		options?: TransportSendOptions;
	}> = [];
	public handlers: TransportHandlers = {};

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
		return {
			received: true,
			requestId: String(message.id),
			status: options?.waitForAck === false ? "published" : "received",
			receivedAt: new Date().toISOString(),
		};
	}
}

async function createService(opts: {
	trustStore?: ITrustStore;
	transport?: ManualTransport;
	resolver?: IAgentResolver;
}): Promise<{
	service: TapMessagingService;
	transport: ManualTransport;
	requestJournal: FileRequestJournal;
	dataDir: string;
}> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-connect-"));
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

	const transport = opts.transport ?? new ManualTransport();
	const requestJournal = new FileRequestJournalImpl(dataDir);
	const appRegistry = new TapAppRegistry(dataDir);
	const service = new TapMessagingService(
		{
			config,
			signingProvider: ALICE_SIGNING_PROVIDER,
			trustStore: opts.trustStore ?? createMemoryTrustStore(),
			resolver: opts.resolver ?? createStaticResolver(),
			conversationLogger: createNoopConversationLogger(),
			requestJournal,
			transport,
			appRegistry,
		},
		{ ownerLabel: "tap:connect-test" },
	);

	return { service, transport, requestJournal, dataDir };
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe("connect() synchronous waiting (spec §3.1 + Task 4.2)", () => {
	it("resolves to active when connection/result arrives within waitMs", async () => {
		const transport = new ManualTransport();
		const trustStore = createMemoryTrustStore();
		const { service } = await createService({ transport, trustStore });

		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		const before = Date.now();
		const connectPromise = service.connect({ inviteUrl: url, waitMs: 5_000 });

		// Deliver the accepted result asynchronously after send() completes.
		for (let attempt = 0; attempt < 20 && transport.sentMessages.length === 0; attempt += 1) {
			await sleep(10);
		}
		expect(transport.sentMessages[0]).toBeDefined();
		const sentRequestId = String(transport.sentMessages[0]!.message.id);
		await transport.handlers.onResult?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "peer-inbox-connect-active",
			message: buildConnectionResult({
				requestId: sentRequestId,
				from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
				status: "accepted",
				timestamp: new Date().toISOString(),
			}),
		});

		const result = await connectPromise;
		const elapsed = Date.now() - before;

		// Resolved active before the 5-second waitMs.
		expect(result.status).toBe("active");
		expect(elapsed).toBeLessThan(5_000);

		// Contact is active.
		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("active");
	});

	it("returns pending when waitMs expires before result", async () => {
		const transport = new ManualTransport();
		const trustStore = createMemoryTrustStore();
		const { service } = await createService({ transport, trustStore });

		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		const before = Date.now();
		// Short waitMs so the test runs quickly.
		const result = await service.connect({ inviteUrl: url, waitMs: 80 });
		const elapsed = Date.now() - before;

		// Returns pending (no throw) after waitMs.
		expect(result.status).toBe("pending");
		expect(elapsed).toBeGreaterThanOrEqual(70);

		// Contact is still connecting.
		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("connecting");
	});

	it("waitMs=0 returns immediately without waiting", async () => {
		const transport = new ManualTransport();
		const trustStore = createMemoryTrustStore();
		const { service } = await createService({ transport, trustStore });

		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		const before = Date.now();
		const result = await service.connect({ inviteUrl: url, waitMs: 0 });
		const elapsed = Date.now() - before;

		// Returns immediately (fire-and-forget).
		expect(result.status).toBe("pending");
		expect(elapsed).toBeLessThan(500);

		// Wire message was sent.
		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]?.message.method).toBe("connection/request");
	});

	it("throws ValidationError when the peer explicitly rejects the invite", async () => {
		// ImmediateRejectTransport delivers a rejection during send().
		class ImmediateRejectTransport extends ManualTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "connection/request") {
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-connect-rejected",
						message: buildConnectionResult({
							requestId: String(message.id),
							from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
							status: "rejected",
							reason: "not interested",
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

		const transport = new ImmediateRejectTransport();
		const trustStore = createMemoryTrustStore();
		const { service } = await createService({ transport, trustStore });

		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		// Should throw ValidationError immediately (not wait for full waitMs).
		const before = Date.now();
		await expect(service.connect({ inviteUrl: url, waitMs: 5_000 })).rejects.toThrow(
			ValidationError,
		);
		await expect(service.connect({ inviteUrl: url, waitMs: 5_000 })).rejects.toThrow(
			"Connection rejected by Bob",
		);
		const elapsed = Date.now() - before;

		// Fast — much less than 5 seconds.
		expect(elapsed).toBeLessThan(2_000);

		// Connecting contact was removed.
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
	});

	it("reuses an existing non-terminal outbound journal entry (wire idempotency)", async () => {
		const transport = new ManualTransport();
		const trustStore = createMemoryTrustStore();
		const { service, requestJournal } = await createService({ transport, trustStore });

		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		// First connect() call — fire-and-forget so it returns quickly.
		const result1 = await service.connect({ inviteUrl: url, waitMs: 0 });
		expect(result1.status).toBe("pending");
		expect(transport.sentMessages).toHaveLength(1);
		const firstRequestId = String(transport.sentMessages[0]!.message.id);

		// Second connect() call with the same invite — should reuse the existing
		// outbound journal entry's requestId (wire-level idempotency).
		const result2 = await service.connect({ inviteUrl: url, waitMs: 0 });
		expect(result2.status).toBe("pending");
		// A second wire message was sent, but it should carry the SAME requestId.
		expect(transport.sentMessages).toHaveLength(2);
		const secondRequestId = String(transport.sentMessages[1]!.message.id);
		expect(secondRequestId).toBe(firstRequestId);

		// Only one journal entry exists (the second call reused it via putOutbound upsert).
		const allEntries = await requestJournal.list("outbound");
		const connectionRequests = allEntries.filter(
			(e) => e.method === CONNECTION_REQUEST && e.peerAgentId === PEER_AGENT.agentId,
		);
		expect(connectionRequests).toHaveLength(1);
		expect(connectionRequests[0]?.status).toBe("pending");
	});
});
