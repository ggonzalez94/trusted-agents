/**
 * Auto-accept connection request tests (spec §1.5).
 *
 * An invite is cryptographic consent. Any validly-signed inbound
 * connection/request is auto-accepted — no approval hook is consulted.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import { buildConnectionRequest } from "../../../src/connection/handshake.js";
import { generateInvite } from "../../../src/connection/invite.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
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

/** The remote peer (Bob) who sends connection/request messages. */
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

class FakeTransport implements TransportProvider {
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
			receivedAt: "2026-03-07T00:00:00.000Z",
		};
	}
}

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
		markRead: async () => {},
	};
}

async function createService(
	dependencies: {
		trustStore?: ITrustStore;
		resolver?: IAgentResolver;
		transport?: FakeTransport;
		hooks?: ConstructorParameters<typeof TapMessagingService>[1]["hooks"];
	} = {},
): Promise<{
	service: TapMessagingService;
	transport: FakeTransport;
	requestJournal: FileRequestJournal;
}> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-auto-accept-"));
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
	const requestJournal = new FileRequestJournalImpl(dataDir);
	const transport = dependencies.transport ?? new FakeTransport();
	const appRegistry = new TapAppRegistry(dataDir);
	const service = new TapMessagingService(
		{
			config,
			signingProvider: ALICE_SIGNING_PROVIDER,
			trustStore: dependencies.trustStore ?? createMemoryTrustStore(),
			resolver: dependencies.resolver ?? createStaticResolver(),
			conversationLogger: createNoopConversationLogger(),
			requestJournal,
			transport,
			appRegistry,
		},
		{
			ownerLabel: "tap:auto-accept-test",
			hooks: dependencies.hooks,
		},
	);

	return { service, transport, requestJournal };
}

async function submitConnectionRequest(
	transport: FakeTransport,
	senderInboxId: string,
	/** agentId that the invite targets — defaults to agent 1 (Alice's agentId in createService) */
	targetAgentId = 1,
): Promise<ProtocolMessage> {
	const { invite } = await generateInvite({
		agentId: targetAgentId,
		chain: "eip155:8453",
		signingProvider: ALICE_SIGNING_PROVIDER,
		expirySeconds: 3600,
	});

	const request = buildConnectionRequest({
		from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
		invite,
		timestamp: "2026-03-08T00:00:00.000Z",
	});

	await expect(
		transport.handlers.onRequest?.({
			from: PEER_AGENT.agentId,
			senderInboxId,
			message: request,
		}),
	).resolves.toEqual({ status: "queued" });

	return request;
}

async function waitForCondition(description: string, predicate: () => Promise<boolean> | boolean) {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(20);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function waitForActiveContact(trustStore: ITrustStore): Promise<Contact> {
	let contact: Contact | null = null;
	await waitForCondition("active auto-accepted contact", async () => {
		contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		return contact?.status === "active";
	});
	return contact!;
}

async function waitForJournalStatus(
	requestJournal: FileRequestJournal,
	requestId: string,
	status: "completed" | "pending" | "queued",
) {
	let entry = await requestJournal.getByRequestId(requestId);
	await waitForCondition(`journal entry ${requestId} to be ${status}`, async () => {
		entry = await requestJournal.getByRequestId(requestId);
		return entry?.status === status;
	});
	return entry;
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe("connection request auto-accept (spec §1.5)", () => {
	it("accepts a valid inbound connection/request without any approval hook", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService({ trustStore, transport });

		try {
			await service.start();
			const request = await submitConnectionRequest(transport, "peer-inbox-auto-accept-1");

			// 1. Trust store now has Bob as an active contact.
			const contact = await waitForActiveContact(trustStore);
			expect(contact).toEqual(
				expect.objectContaining({
					peerAgentId: PEER_AGENT.agentId,
					peerChain: PEER_AGENT.chain,
					status: "active",
				}),
			);

			// 2. Transport received an outbound connection/result with status "accepted".
			const connectionResults = transport.sentMessages.filter(
				(entry) => entry.message.method === "connection/result",
			);
			expect(connectionResults).toHaveLength(1);
			const resultParams = connectionResults[0]?.message.params as { status?: string };
			expect(resultParams?.status).toBe("accepted");

			// 3. The inbound journal entry is "completed".
			expect(await waitForJournalStatus(requestJournal, String(request.id), "completed")).toEqual(
				expect.objectContaining({ status: "completed" }),
			);
		} finally {
			await service.stop();
		}
	});

	it("rejects a connection/request with an invalid invite signature", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService({ trustStore, transport });

		try {
			await service.start();

			// Build an invite signed by BOB_SIGNING_PROVIDER (not ALICE who owns agent 1)
			// so the signature verification fails.
			const { invite } = await generateInvite({
				agentId: 1,
				chain: "eip155:8453",
				signingProvider: BOB_SIGNING_PROVIDER, // wrong signer — Alice owns agent 1
				expirySeconds: 3600,
			});

			const request = buildConnectionRequest({
				from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
				invite,
				timestamp: "2026-03-08T00:00:00.000Z",
			});

			await expect(
				transport.handlers.onRequest?.({
					from: PEER_AGENT.agentId,
					senderInboxId: "peer-inbox-bad-sig",
					message: request,
				}),
			).resolves.toEqual({ status: "queued" });

			await waitForJournalStatus(requestJournal, String(request.id), "completed");

			// Outbound connection/result should be "rejected".
			const connectionResults = transport.sentMessages.filter(
				(entry) => entry.message.method === "connection/result",
			);
			expect(connectionResults).toHaveLength(1);
			const resultParams = connectionResults[0]?.message.params as {
				status?: string;
				reason?: string;
			};
			expect(resultParams?.status).toBe("rejected");

			// No contact should have been created.
			expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();

			// Journal entry should be completed (the rejection response was sent).
			expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
				expect.objectContaining({ status: "completed" }),
			);
		} finally {
			await service.stop();
		}
	});

	it("calls onConnectionEstablished hook after successful auto-accept", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const onConnectionEstablished = vi.fn();
		const { service } = await createService({
			trustStore,
			transport,
			hooks: { onConnectionEstablished },
		});

		await service.start();
		await submitConnectionRequest(transport, "peer-inbox-hook-test");
		await waitForCondition(
			"onConnectionEstablished hook",
			() => onConnectionEstablished.mock.calls.length > 0,
		);

		expect(onConnectionEstablished).toHaveBeenCalledOnce();
		expect(onConnectionEstablished).toHaveBeenCalledWith({
			peerAgentId: PEER_AGENT.agentId,
			peerName: PEER_AGENT.registrationFile.name,
			peerChain: PEER_AGENT.chain,
		});

		await service.stop();
	});

	it("does not call onConnectionEstablished hook when invite is invalid", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const onConnectionEstablished = vi.fn();
		const { service } = await createService({
			trustStore,
			transport,
			hooks: { onConnectionEstablished },
		});

		await service.start();

		const { invite } = await generateInvite({
			agentId: 1,
			chain: "eip155:8453",
			signingProvider: BOB_SIGNING_PROVIDER, // wrong signer
			expirySeconds: 3600,
		});
		const request = buildConnectionRequest({
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			invite,
			timestamp: "2026-03-08T00:00:00.000Z",
		});
		await transport.handlers.onRequest?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "peer-inbox-hook-invalid",
			message: request,
		});
		await sleep(50);

		expect(onConnectionEstablished).not.toHaveBeenCalled();

		await service.stop();
	});

	it("swallows errors thrown by onConnectionEstablished hook", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const onConnectionEstablished = vi.fn(() => {
			throw new Error("hook error");
		});
		const { service, requestJournal } = await createService({
			trustStore,
			transport,
			hooks: { onConnectionEstablished },
		});

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-hook-error");

		// Contact should still be created despite the hook error.
		const contact = await waitForActiveContact(trustStore);
		expect(contact?.status).toBe("active");

		// Journal entry should be completed.
		expect(await waitForJournalStatus(requestJournal, String(request.id), "completed")).toEqual(
			expect.objectContaining({ status: "completed" }),
		);

		await service.stop();
	});
});
