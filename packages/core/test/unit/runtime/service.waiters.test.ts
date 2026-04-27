/**
 * Connect waiter lifecycle tests (spec §3.2 + Task 4.1).
 *
 * Exercises the inFlightConnectWaiters infrastructure:
 * - resolve on matching connection/result
 * - timeout after waitMs
 * - reject all on service.stop()
 * - gracefully handles unknown requestIds
 *
 * All tests operate at the public connect() + transport-handler level.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import { buildConnectionResult } from "../../../src/connection/handshake.js";
import { generateInvite } from "../../../src/connection/invite.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { FileRequestJournal as FileRequestJournalImpl } from "../../../src/runtime/request-journal.js";
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
import { jsonClone } from "../../helpers/clone.js";
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
// Test helpers
// ──────────────────────────────────────────────────────────────

function createMemoryTrustStore(initialContacts: Contact[] = []): ITrustStore {
	const contacts = new Map(
		initialContacts.map((contact) => [contact.connectionId, jsonClone(contact)]),
	);
	return {
		getContacts: async () => [...contacts.values()].map((c) => jsonClone(c)),
		getContact: async (id: string) => jsonClone(contacts.get(id) ?? null),
		findByAgentAddress: async (address: `0x${string}`, chain?: string) =>
			jsonClone(
				[...contacts.values()].find(
					(c) =>
						c.peerAgentAddress.toLowerCase() === address.toLowerCase() &&
						(chain === undefined || c.peerChain === chain),
				) ?? null,
			),
		findByAgentId: async (agentId: number, chain: string) =>
			jsonClone(
				[...contacts.values()].find((c) => c.peerAgentId === agentId && c.peerChain === chain) ??
					null,
			),
		addContact: async (contact: Contact) => {
			contacts.set(contact.connectionId, jsonClone(contact));
		},
		updateContact: async (connectionId: string, updates: Partial<Contact>) => {
			const existing = contacts.get(connectionId);
			if (!existing) return;
			contacts.set(connectionId, jsonClone({ ...existing, ...updates }));
		},
		removeContact: async (connectionId: string) => {
			contacts.delete(connectionId);
		},
		touchContact: async (connectionId: string) => {
			const existing = contacts.get(connectionId);
			if (!existing) return;
			contacts.set(
				connectionId,
				jsonClone({ ...existing, lastContactAt: new Date().toISOString() }),
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
		markRead: async () => {},
	};
}

/**
 * A transport that records sent messages and exposes its handlers so tests can
 * drive inbound results manually.
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

async function waitFor(
	check: () => boolean,
	{ timeoutMs = 500, pollMs = 10 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for test condition`);
		}
		await sleep(pollMs);
	}
}

async function createService(opts: {
	trustStore?: ITrustStore;
	transport?: ManualTransport;
}): Promise<{
	service: TapMessagingService;
	transport: ManualTransport;
}> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-waiters-"));
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
			resolver: createStaticResolver(),
			conversationLogger: createNoopConversationLogger(),
			requestJournal,
			transport,
			appRegistry,
		},
		{ ownerLabel: "tap:waiters-test" },
	);

	return { service, transport };
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe("connect waiter lifecycle (spec §3.2 + Task 4.1)", () => {
	it("resolves when a matching connection/result arrives within waitMs", async () => {
		const transport = new ManualTransport();
		const trustStore = createMemoryTrustStore();
		const { service } = await createService({ transport, trustStore });

		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		// Start the connect() — it will block waiting for a result.
		const connectStart = Date.now();
		const connectPromise = service.connect({ inviteUrl: url, waitMs: 5_000 });

		// Wait for the send to be recorded, then deliver the accepted result.
		await waitFor(() => transport.sentMessages.length === 1);
		expect(transport.sentMessages).toHaveLength(1);
		const sentRequestId = String(transport.sentMessages[0]!.message.id);

		await transport.handlers.onResult?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "peer-inbox-waiter-resolve",
			message: buildConnectionResult({
				requestId: sentRequestId,
				from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
				status: "accepted",
				timestamp: new Date().toISOString(),
			}),
		});

		const result = await connectPromise;
		const elapsed = Date.now() - connectStart;

		// Returns active — and faster than waitMs (didn't wait the full 5 seconds).
		expect(result.status).toBe("active");
		expect(elapsed).toBeLessThan(5_000);

		// Contact is active in the trust store.
		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("active");
	});

	it("returns pending when waitMs expires before result arrives", async () => {
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

		// Returns pending (no throw) after approximately waitMs.
		expect(result.status).toBe("pending");
		expect(elapsed).toBeGreaterThanOrEqual(70);

		// Contact is still in "connecting" state.
		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("connecting");
	});

	it("waitMs=0 returns immediately without waiting for a result", async () => {
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

	it("rejects when the peer explicitly rejects the invite", async () => {
		// Use ImmediateRejectTransport pattern: calls onResult during send.
		class ImmediateRejectTransport extends ManualTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "connection/request") {
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-waiter-rejected",
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

		// Should throw ValidationError immediately (not wait for timeout).
		const before = Date.now();
		await expect(service.connect({ inviteUrl: url, waitMs: 5_000 })).rejects.toThrow(
			"Connection rejected by Bob (#10)",
		);
		const elapsed = Date.now() - before;

		// Fast rejection — much less than waitMs.
		expect(elapsed).toBeLessThan(2_000);

		// Connecting contact was removed by the rejection handler.
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
	});

	it("clears all pending waiters when service.stop() is called", async () => {
		const transport = new ManualTransport();
		const trustStore = createMemoryTrustStore();
		const { service } = await createService({ transport, trustStore });

		// Must start the service so that stop() does not return early.
		await service.start();

		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		// Start a connect() that will block waiting for a result (10 second timeout).
		// The executionMutex means connect() is entered sequentially: start() finishes
		// its own runExclusive first, then connect() is entered. The waiter is
		// registered inside connect() before it awaits the waiterPromise.
		const connectPromise = service.connect({ inviteUrl: url, waitMs: 10_000 });

		// Give connect() time to register the waiter and reach the await.
		await sleep(50);

		// Stop the service. This calls rejectAllConnectWaiters() which rejects the
		// waiter, causing connectInternal to throw, which propagates to connect().
		void service.stop();

		// The connect promise should reject with the "stopped" reason.
		await expect(connectPromise).rejects.toThrow("TapMessagingService stopped");
	});

	it("ignores results with unknown requestIds without crashing", async () => {
		// When a connection/result arrives for a requestId that has no registered
		// waiter, resolveConnectWaiter is a no-op. The result is still processed
		// normally by handleConnectionResult.
		const transport = new ManualTransport();
		const trustStore = createMemoryTrustStore();
		const { service } = await createService({ transport, trustStore });

		await service.start();

		// Deliver an accepted result for a requestId nobody sent — no waiter.
		// handleConnectionResult runs the "missing contact" recovery path: resolves
		// the peer on-chain (our static resolver returns PEER_AGENT) and creates a
		// fresh active contact.
		const resultStatus = await transport.handlers.onResult?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "peer-inbox-unknown-id",
			message: buildConnectionResult({
				requestId: "completely-unknown-request-id",
				from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
				status: "accepted",
				timestamp: new Date().toISOString(),
			}),
		});

		// No throw — the handler processes the result without a waiter.
		expect(resultStatus).toBeDefined();

		await service.stop();
	});
});
