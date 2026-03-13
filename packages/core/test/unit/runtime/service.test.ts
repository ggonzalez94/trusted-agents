import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportError, ValidationError } from "../../../src/common/errors.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import {
	buildConnectionRequest,
	buildConnectionResult,
	buildPermissionsUpdate,
} from "../../../src/connection/handshake.js";
import { generateInvite } from "../../../src/connection/invite.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { createEmptyPermissionState, createGrantSet } from "../../../src/permissions/types.js";
import {
	FileTapCommandOutbox,
	buildOutgoingActionRequest,
	buildOutgoingActionResult,
	parseTransferActionRequest,
	parseTransferActionResponse,
} from "../../../src/runtime/index.js";
import type { FileRequestJournal } from "../../../src/runtime/request-journal.js";
import { FileRequestJournal as FileRequestJournalImpl } from "../../../src/runtime/request-journal.js";
import { TapMessagingService } from "../../../src/runtime/service.js";
import type {
	ProtocolMessage,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "../../../src/transport/interface.js";
import type { ITrustStore } from "../../../src/trust/trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import { ALICE, BOB } from "../../fixtures/test-keys.js";

const tempDirs: string[] = [];

class FakeTransport implements TransportProvider {
	public startCalls = 0;
	public stopCalls = 0;
	public reconcileCalls = 0;
	public handlers: TransportHandlers = {};

	constructor(
		private readonly options: {
			reconcileProcessed?: number;
			failOnStart?: boolean;
			sendError?: Error;
		} = {},
	) {}

	public readonly sentMessages: Array<{ peerId: number; message: ProtocolMessage }> = [];

	setHandlers(handlers: TransportHandlers): void {
		this.handlers = handlers;
	}

	async start(): Promise<void> {
		this.startCalls += 1;
		if (this.options.failOnStart) {
			throw new Error("transport start failed");
		}
	}

	async stop(): Promise<void> {
		this.stopCalls += 1;
	}

	async isReachable(): Promise<boolean> {
		return true;
	}

	async reconcile() {
		this.reconcileCalls += 1;
		return {
			synced: true as const,
			processed: this.options.reconcileProcessed ?? 0,
		};
	}

	async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
		this.sentMessages.push({
			peerId,
			message,
		});
		if (this.options.sendError) {
			throw this.options.sendError;
		}
		return {
			received: true,
			requestId: String(message.id),
			status: "received",
			receivedAt: "2026-03-07T00:00:00.000Z",
		};
	}
}

const PEER_AGENT: ResolvedAgent = {
	agentId: 10,
	chain: "eip155:84532",
	ownerAddress: BOB.address,
	agentAddress: BOB.address,
	capabilities: ["chat", "payments"],
	registrationFile: {
		type: "eip-8004-registration-v1",
		name: "Bob",
		description: "Peer agent",
		services: [{ name: "xmtp", endpoint: BOB.address }],
		trustedAgentProtocol: {
			version: "1.0",
			agentAddress: BOB.address,
			capabilities: ["chat", "payments"],
		},
	},
	resolvedAt: "2026-03-07T00:00:00.000Z",
};

function cloneContact<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function createMemoryTrustStore(initialContacts: Contact[] = []): ITrustStore {
	const contacts = new Map(
		initialContacts.map((contact) => [contact.connectionId, cloneContact(contact)]),
	);
	return {
		getContacts: async () => [...contacts.values()].map((contact) => cloneContact(contact)),
		getContact: async (connectionId: string) => cloneContact(contacts.get(connectionId) ?? null),
		findByAgentAddress: async (address: `0x${string}`, chain?: string) =>
			cloneContact(
				[...contacts.values()].find(
					(contact) =>
						contact.peerAgentAddress.toLowerCase() === address.toLowerCase() &&
						(chain === undefined || contact.peerChain === chain),
				) ?? null,
			),
		findByAgentId: async (agentId: number, chain: string) =>
			cloneContact(
				[...contacts.values()].find(
					(contact) => contact.peerAgentId === agentId && contact.peerChain === chain,
				) ?? null,
			),
		addContact: async (contact: Contact) => {
			contacts.set(contact.connectionId, cloneContact(contact));
		},
		updateContact: async (connectionId: string, updates: Partial<Contact>) => {
			const existing = contacts.get(connectionId);
			if (!existing) {
				return;
			}
			contacts.set(connectionId, cloneContact({ ...existing, ...updates }));
		},
		removeContact: async (connectionId: string) => {
			contacts.delete(connectionId);
		},
		touchContact: async (connectionId: string) => {
			const existing = contacts.get(connectionId);
			if (!existing) {
				return;
			}
			contacts.set(connectionId, {
				...cloneContact(existing),
				lastContactAt: "2026-03-08T00:00:00.000Z",
			});
		},
	};
}

function createStaticResolver(agent: ResolvedAgent = PEER_AGENT): IAgentResolver {
	return {
		resolve: async (_agentId: number, _chain: string) => agent,
		resolveWithCache: async (_agentId: number, _chain: string, _maxAgeMs?: number) => agent,
	};
}

function createNoopConversationLogger(): IConversationLogger {
	return {
		logMessage: async (_conversationId, _message, _context) => {},
		getConversation: async (_conversationId) => null,
		listConversations: async (_filter) => [],
		generateTranscript: async (_conversationId) => "",
	};
}

async function createService(
	options: {
		reconcileProcessed?: number;
		failOnStart?: boolean;
		sendError?: Error;
	} = {},
	dependencies: {
		trustStore?: ITrustStore;
		resolver?: IAgentResolver;
		transport?: FakeTransport;
		hooks?: ConstructorParameters<typeof TapMessagingService>[1]["hooks"];
		serviceOptions?: Omit<
			ConstructorParameters<typeof TapMessagingService>[1],
			"hooks" | "ownerLabel"
		>;
	} = {},
): Promise<{
	service: TapMessagingService;
	transport: FakeTransport;
	requestJournal: FileRequestJournal;
	dataDir: string;
}> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-service-"));
	tempDirs.push(dataDir);

	const config: TrustedAgentsConfig = {
		agentId: 1,
		chain: "eip155:84532",
		privateKey: ALICE.privateKey,
		dataDir,
		chains: {},
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60_000,
		resolveCacheMaxEntries: 128,
		xmtpEnv: "dev",
	};
	const requestJournal = new FileRequestJournalImpl(dataDir);
	const transport = dependencies.transport ?? new FakeTransport(options);
	const service = new TapMessagingService(
		{
			config,
			trustStore: dependencies.trustStore ?? createMemoryTrustStore(),
			resolver: dependencies.resolver ?? createStaticResolver(),
			conversationLogger: createNoopConversationLogger(),
			requestJournal,
			transport,
		},
		{
			ownerLabel: "tap:test-service",
			hooks: dependencies.hooks,
			...(dependencies.serviceOptions ?? {}),
		},
	);

	return { service, transport, requestJournal, dataDir };
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
	);
});

describe("TapMessagingService", () => {
	it("uses a scoped transport session for syncOnce", async () => {
		const { service, transport } = await createService({ reconcileProcessed: 3 });

		const report = await service.syncOnce();

		expect(report).toEqual({
			synced: true,
			processed: 3,
			pendingRequests: [],
		});
		expect(transport.startCalls).toBe(1);
		expect(transport.stopCalls).toBe(1);
		expect(transport.reconcileCalls).toBe(1);

		const status = await service.getStatus();
		expect(status.running).toBe(false);
		expect(status.lock).toBeNull();
		expect(status.lastSyncAt).toBeDefined();
		expect(transport.handlers.onRequest).toBeTypeOf("function");
		expect(transport.handlers.onResult).toBeTypeOf("function");
	});

	it("keeps the transport session open across start and stop", async () => {
		const { service, transport } = await createService({ reconcileProcessed: 1 });

		await service.start();

		expect(transport.startCalls).toBe(1);
		expect(transport.stopCalls).toBe(0);
		expect(transport.reconcileCalls).toBe(1);

		const runningStatus = await service.getStatus();
		expect(runningStatus.running).toBe(true);
		expect(runningStatus.lock).toEqual(
			expect.objectContaining({
				owner: "tap:test-service",
			}),
		);

		await service.syncOnce();
		expect(transport.startCalls).toBe(1);
		expect(transport.stopCalls).toBe(0);
		expect(transport.reconcileCalls).toBe(2);

		await service.stop();

		const stoppedStatus = await service.getStatus();
		expect(stoppedStatus.running).toBe(false);
		expect(stoppedStatus.lock).toBeNull();
		expect(transport.stopCalls).toBe(1);
	});

	it("releases the ownership lock if start fails", async () => {
		const { service } = await createService({ failOnStart: true });

		await expect(service.start()).rejects.toThrow("transport start failed");

		const status = await service.getStatus();
		expect(status.running).toBe(false);
		expect(status.lock).toBeNull();
	});

	it("completes inbound connection requests even when the result receipt times out", async () => {
		const transport = new FakeTransport({
			sendError: new TransportError("Response timeout for message result-1"),
		});
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				serviceOptions: { autoApproveConnections: true },
			},
		);

		await service.start();

		const request = buildConnectionRequest({
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			to: { agentId: 1, chain: "eip155:84532" },
			connectionId: "conn-timeout-1",
			nonce: "nonce-timeout-1",
			protocolVersion: "1.0",
			timestamp: "2026-03-08T00:00:00.000Z",
		});

		await expect(
			transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-1",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await service.stop();

		expect((await requestJournal.getByRequestId(String(request.id)))?.status).toBe("completed");
		await expect(
			transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-1",
				message: request,
			}),
		).resolves.toEqual({ status: "duplicate" });
	});

	it("resolves queued inbound connection requests from local journal state", async () => {
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();

		const request = buildConnectionRequest({
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			to: { agentId: 1, chain: "eip155:84532" },
			connectionId: "conn-manual-resolve-1",
			nonce: "nonce-manual-resolve-1",
			protocolVersion: "1.0",
			timestamp: "2026-03-08T00:00:00.000Z",
		});

		await expect(
			transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-manual-resolve",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		expect(await service.listPendingRequests()).toEqual([
			expect.objectContaining({
				requestId: String(request.id),
				method: "connection/request",
				peerAgentId: PEER_AGENT.agentId,
			}),
		]);

		const report = await service.resolvePending(String(request.id), true);

		expect(report.pendingRequests).toEqual([]);
		expect((await requestJournal.getByRequestId(String(request.id)))?.status).toBe("completed");
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				connectionId: "conn-manual-resolve-1",
				status: "active",
			}),
		);
		expect(transport.sentMessages.map((entry) => entry.message.method)).toEqual([
			"connection/result",
		]);

		await service.stop();
	});

	it("retries pending connection result delivery during maintenance", async () => {
		class FlakyConnectionResultTransport extends FakeTransport {
			private failConnectionResultOnce = true;

			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "connection/result" && this.failConnectionResultOnce) {
					this.failConnectionResultOnce = false;
					throw new TransportError("temporary connection result send failure");
				}
				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new FlakyConnectionResultTransport();
		const trustStore = createMemoryTrustStore();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
				serviceOptions: { autoApproveConnections: true },
			},
		);

		await service.start();

		const request = buildConnectionRequest({
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			to: { agentId: 1, chain: "eip155:84532" },
			connectionId: "conn-connection-retry-1",
			nonce: "nonce-connection-retry-1",
			protocolVersion: "1.0",
			timestamp: "2026-03-08T00:00:00.000Z",
		});

		await expect(
			transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-connection-retry",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		const firstConnectionResult = transport.sentMessages.find(
			(entry) => entry.message.method === "connection/result",
		);
		expect(firstConnectionResult).toBeDefined();
		expect((await requestJournal.getByRequestId(String(request.id)))?.status).toBe("completed");
		expect(
			(await requestJournal.getByRequestId(String(firstConnectionResult!.message.id)))?.status,
		).toBe("pending");
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				connectionId: "conn-connection-retry-1",
				status: "active",
			}),
		);

		await service.processOutboxOnce();

		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "connection/result"),
		).toHaveLength(2);
		expect(
			(await requestJournal.getByRequestId(String(firstConnectionResult!.message.id)))?.status,
		).toBe("completed");

		await service.stop();
	});

	it("rejects self-invites before starting transport", async () => {
		const selfAgent: ResolvedAgent = {
			...PEER_AGENT,
			agentId: 1,
			chain: "eip155:84532",
			registrationFile: {
				...PEER_AGENT.registrationFile,
				name: "Alice",
			},
		};
		const selfInviteUrl =
			"https://trustedagents.link/connect?agentId=1&chain=eip155%3A84532&nonce=self-invite-1&expires=1893456000&sig=0x84d4ec88a170f9fa36c886b55b65d5a1baad7f15db24a51979fddef4a8b7b26f0c2ed45a62dff70d5287298a0c63d24751f64ca19b006ef3df435e74e6eaf2571b";
		const { service, transport } = await createService(
			{},
			{
				resolver: createStaticResolver(selfAgent),
			},
		);

		await expect(service.connect({ inviteUrl: selfInviteUrl })).rejects.toThrow(ValidationError);
		await expect(service.connect({ inviteUrl: selfInviteUrl })).rejects.toThrow(
			"Cannot connect to your own invite",
		);
		expect(transport.startCalls).toBe(0);
		expect(transport.sentMessages).toHaveLength(0);
	});

	it("keeps an outbound connection pending when the receipt times out", async () => {
		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			privateKey: BOB.privateKey,
			expirySeconds: 3600,
		});
		const transport = new FakeTransport({
			sendError: new TransportError("Response timeout for message connect-timeout-1"),
		});
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
			},
		);

		const result = await service.connect({ inviteUrl: url });

		expect(result.status).toBe("pending");
		expect(result.receipt).toBeUndefined();
		expect(
			(await requestJournal.getByRequestId(transport.sentMessages[0]!.message.id as string))
				?.status,
		).toBe("pending");
	});

	it("returns active when the peer accepts during the same transport session", async () => {
		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			privateKey: BOB.privateKey,
			expirySeconds: 3600,
		});

		class ImmediateAcceptTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "connection/request") {
					const params = message.params as {
						from: { agentId: number; chain: string };
						to: { agentId: number; chain: string };
						connectionId: string;
						nonce: string;
					};
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-immediate",
						message: buildConnectionResult({
							requestId: String(message.id),
							requestNonce: params.nonce,
							from: params.to,
							to: params.from,
							status: "accepted",
							connectionId: params.connectionId,
							timestamp: "2026-03-08T00:00:01.000Z",
						}),
					});
				}

				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new ImmediateAcceptTransport();
		const { service } = await createService(
			{},
			{
				transport,
			},
		);

		const result = await service.connect({ inviteUrl: url });

		expect(result.status).toBe("active");
		expect(transport.sentMessages.map((entry) => entry.message.method)).toContain(
			"connection/request",
		);
	});

	it("fails when the peer rejects during the same transport session", async () => {
		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			privateKey: BOB.privateKey,
			expirySeconds: 3600,
		});

		class ImmediateRejectTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "connection/request") {
					const params = message.params as {
						from: { agentId: number; chain: string };
						to: { agentId: number; chain: string };
						nonce: string;
					};
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-rejected",
						message: buildConnectionResult({
							requestId: String(message.id),
							requestNonce: params.nonce,
							from: params.to,
							to: params.from,
							status: "rejected",
							reason: "no thanks",
							timestamp: "2026-03-08T00:00:01.000Z",
						}),
					});
				}

				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new ImmediateRejectTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
			},
		);

		await expect(service.connect({ inviteUrl: url })).rejects.toThrow(
			"Connection rejected by Bob (#10)",
		);
		expect(
			(await requestJournal.getByRequestId(String(transport.sentMessages[0]!.message.id)))?.status,
		).toBe("completed");
	});

	it("ignores stale rejected connection results for a different outbound request", async () => {
		const pendingContact: Contact = {
			connectionId: "conn-current-1",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "pending",
			pending: {
				direction: "outbound",
				requestId: "req-current-1",
				requestNonce: "nonce-current-1",
				requestedAt: "2026-03-08T00:00:00.000Z",
			},
		};
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore([pendingContact]);
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		await requestJournal.putOutbound({
			requestId: "req-stale-1",
			requestKey: "outbound:connection/request:req-stale-1",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: PEER_AGENT.agentId,
			status: "acked",
		});

		const staleRejectedResult = buildConnectionResult({
			requestId: "req-stale-1",
			requestNonce: "nonce-stale-1",
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			to: { agentId: 1, chain: "eip155:84532" },
			status: "rejected",
			reason: "stale rejection",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-stale-result",
				message: staleRejectedResult,
			}),
		).resolves.toEqual({ status: "received" });

		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("pending");
		expect(contact?.connectionId).toBe("conn-current-1");
		expect((await requestJournal.getByRequestId("req-stale-1"))?.status).toBe("completed");
	});

	it("processes queued outbound commands during syncOnce", async () => {
		const activeContact: Contact = {
			connectionId: "conn-message-1",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};
		const { service, transport, dataDir } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([activeContact]),
			},
		);
		const outbox = new FileTapCommandOutbox(dataDir);
		const queued = await outbox.enqueue({
			type: "send-message",
			payload: {
				peer: activeContact.peerDisplayName,
				text: "queued hello",
				scope: "general-chat",
			},
			requestedBy: "test",
		});

		const report = await service.syncOnce();

		expect(report.processed).toBe(1);
		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]?.message.method).toBe("message/send");
		expect(await outbox.getResult(queued.jobId)).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
	});

	it("processes queued connect commands during syncOnce", async () => {
		const { service, transport, dataDir } = await createService();
		const outbox = new FileTapCommandOutbox(dataDir);
		const invite = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			privateKey: BOB.privateKey,
			expirySeconds: 3600,
		});
		const queued = await outbox.enqueue({
			type: "connect",
			payload: {
				inviteUrl: invite.url,
			},
			requestedBy: "test",
		});

		const report = await service.syncOnce();

		expect(report.processed).toBe(1);
		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]?.message.method).toBe("connection/request");
		expect(await outbox.getResult(queued.jobId)).toEqual(
			expect.objectContaining({
				status: "completed",
				result: expect.objectContaining({
					status: "pending",
				}),
			}),
		);
	});

	it("polls queued outbound commands while the listener is running", async () => {
		const activeContact: Contact = {
			connectionId: "conn-grants-1",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};
		const { service, transport, dataDir } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([activeContact]),
				serviceOptions: {
					outboxPollIntervalMs: 25,
				},
			},
		);
		const outbox = new FileTapCommandOutbox(dataDir);

		await service.start();
		const queued = await outbox.enqueue({
			type: "publish-grant-set",
			payload: {
				peer: activeContact.peerDisplayName,
				grantSet: {
					version: "tap-grants/v1",
					updatedAt: "2026-03-08T00:00:00.000Z",
					grants: [{ grantId: "queued-chat", scope: "general-chat" }],
				},
				note: "queued publish",
			},
			requestedBy: "test",
		});

		await sleep(150);
		await service.stop();

		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]?.message.method).toBe("permissions/update");
		expect(await outbox.getResult(queued.jobId)).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
	});

	it("captures an action result that arrives before requestFunds finishes sending", async () => {
		const activeContact: Contact = {
			connectionId: "conn-request-funds-fast",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};

		class ImmediateActionResultTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "action/request") {
					const request = parseTransferActionRequest(message);
					if (!request) {
						throw new Error("expected transfer request payload");
					}
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-fast-result",
						message: buildOutgoingActionResult(
							activeContact,
							String(message.id),
							"Transfer complete",
							{
								type: "transfer/response",
								requestId: String(message.id),
								actionId: request.actionId,
								asset: request.asset,
								amount: request.amount,
								chain: request.chain,
								toAddress: request.toAddress,
								status: "completed",
								txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
							},
							"transfer/request",
							"completed",
						),
					});
				}

				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const { service } = await createService(
			{},
			{
				transport: new ImmediateActionResultTransport(),
				trustStore: createMemoryTrustStore([activeContact]),
			},
		);

		const result = await service.requestFunds({
			peer: activeContact.peerDisplayName,
			asset: "native",
			amount: "0.1",
			chain: "eip155:84532",
			toAddress: ALICE.address,
		});

		expect(result.asyncResult).toEqual(
			expect.objectContaining({
				status: "completed",
				actionId: result.actionId,
			}),
		);
	});

	it("retries pending action result delivery during maintenance", async () => {
		const contact: Contact = {
			connectionId: "conn-transfer-retry",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};

		class FlakyActionResultTransport extends FakeTransport {
			private failActionResultOnce = true;

			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "action/result" && this.failActionResultOnce) {
					this.failActionResultOnce = false;
					throw new TransportError("temporary action result send failure");
				}
				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new FlakyActionResultTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: {
					executeTransfer: vi.fn(async () => ({
						txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
					})),
				},
				serviceOptions: { unsafeAutoApproveActions: true },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "transfer-retry-1",
				asset: "native",
				amount: "0.2",
				chain: "eip155:84532",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-retry",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		const firstActionResult = transport.sentMessages.find(
			(entry) => entry.message.method === "action/result",
		);
		expect(firstActionResult).toBeDefined();
		expect(
			(await requestJournal.getByRequestId(String(firstActionResult!.message.id)))?.status,
		).toBe("pending");

		await service.syncOnce();

		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "action/result"),
		).toHaveLength(2);
		expect(
			(await requestJournal.getByRequestId(String(firstActionResult!.message.id)))?.status,
		).toBe("completed");

		await service.stop();
	});

	it("resolves queued transfer requests from local journal state", async () => {
		const contact: Contact = {
			connectionId: "conn-manual-transfer-1",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: {
				...createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
				grantedByMe: createGrantSet(
					[
						{
							grantId: "manual-transfer-approval",
							scope: "transfer/request",
							constraints: {
								asset: "native",
								chain: "eip155:84532",
								toAddress: ALICE.address,
								maxAmount: "1",
							},
						},
					],
					"2026-03-08T00:00:00.000Z",
				),
			},
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as const,
		}));
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { executeTransfer },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "manual-transfer-1",
				asset: "native",
				amount: "0.1",
				chain: "eip155:84532",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-manual-transfer",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		expect(await service.listPendingRequests()).toEqual([
			expect.objectContaining({
				requestId: String(request.id),
				method: "action/request",
				peerAgentId: PEER_AGENT.agentId,
			}),
		]);

		const report = await service.resolvePending(String(request.id), true);
		const actionResult = transport.sentMessages.find(
			(entry) => entry.message.method === "action/result",
		);

		expect(report.pendingRequests).toEqual([]);
		expect(executeTransfer).toHaveBeenCalledOnce();
		expect((await requestJournal.getByRequestId(String(request.id)))?.status).toBe("completed");
		expect(actionResult).toBeDefined();
		expect(parseTransferActionResponse(actionResult!.message)?.status).toBe("completed");

		await service.stop();
	});

	it("marks executed transfer requests completed even if retry metadata persistence fails", async () => {
		const contact: Contact = {
			connectionId: "conn-transfer-journal-fail",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const,
		}));
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { executeTransfer },
				serviceOptions: { unsafeAutoApproveActions: true },
			},
		);
		const originalPutOutbound = requestJournal.putOutbound.bind(requestJournal);
		vi.spyOn(requestJournal, "putOutbound").mockImplementation(async (entry) => {
			if (entry.kind === "result" && entry.method === "action/result") {
				throw new Error("disk full");
			}
			return await originalPutOutbound(entry);
		});

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "transfer-journal-fail-1",
				asset: "native",
				amount: "0.5",
				chain: "eip155:84532",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-journal-fail",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		expect(executeTransfer).toHaveBeenCalledOnce();
		expect((await requestJournal.getByRequestId(String(request.id)))?.status).toBe("completed");
		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "action/result"),
		).toHaveLength(1);
		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-journal-fail",
				message: request,
			}),
		).resolves.toEqual({ status: "duplicate" });
		expect(executeTransfer).toHaveBeenCalledOnce();

		await service.stop();
	});

	it("rejects transfer approvals without a matching grant before consulting hooks", async () => {
		const contact: Contact = {
			connectionId: "conn-transfer-1",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};
		const approveTransfer = vi.fn(async () => true);
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
		}));
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { approveTransfer, executeTransfer },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "transfer-action-1",
				asset: "native",
				amount: "0.1",
				chain: "eip155:84532",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-2",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await service.stop();

		expect(approveTransfer).not.toHaveBeenCalled();
		expect(executeTransfer).not.toHaveBeenCalled();
		const result = parseTransferActionResponse(transport.sentMessages[0]!.message);
		expect(transport.sentMessages[0]?.message.method).toBe("action/result");
		expect(result?.status).toBe("rejected");
	});

	it("allows unsafe transfer auto-approval without matching grants", async () => {
		const contact: Contact = {
			connectionId: "conn-transfer-2",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
		}));
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { executeTransfer },
				serviceOptions: { unsafeAutoApproveActions: true },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "transfer-action-2",
				asset: "usdc",
				amount: "1",
				chain: "eip155:84532",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-3",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await service.stop();

		expect(executeTransfer).toHaveBeenCalledOnce();
		expect(transport.sentMessages[0]?.message.method).toBe("action/result");
		expect(parseTransferActionResponse(transport.sentMessages[0]!.message)?.status).toBe(
			"completed",
		);
	});

	it("captures fast transfer results that arrive before the request call finishes", async () => {
		const contact: Contact = {
			connectionId: "conn-request-funds-fast",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};

		class FastResultTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "action/request") {
					const request = parseTransferActionRequest(message);
					if (request) {
						await this.handlers.onResult?.({
							from: peerId,
							senderInboxId: "peer-inbox-fast-result",
							message: buildOutgoingActionResult(
								contact,
								String(message.id),
								"Transfer completed",
								{
									type: "transfer/response",
									actionId: request.actionId,
									asset: request.asset,
									amount: request.amount,
									chain: request.chain,
									toAddress: request.toAddress,
									status: "completed",
									txHash:
										"0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const,
								},
								"transfer/request",
								"completed",
							),
						});
					}
				}

				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new FastResultTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		const result = await service.requestFunds({
			peer: contact.peerDisplayName,
			asset: "native",
			amount: "0.1",
			chain: "eip155:84532",
			toAddress: ALICE.address,
		});

		expect(result.asyncResult).toEqual(
			expect.objectContaining({
				status: "completed",
				actionId: expect.any(String),
			}),
		);
	});

	it("rejects connection results with the wrong pending nonce", async () => {
		const pendingContact: Contact = {
			connectionId: "conn-wrong-nonce",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "pending",
			pending: {
				direction: "outbound",
				requestId: "req-wrong-nonce",
				requestNonce: "expected-nonce",
				requestedAt: "2026-03-08T00:00:00.000Z",
			},
		};
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore([pendingContact]);
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		await requestJournal.putOutbound({
			requestId: "req-wrong-nonce",
			requestKey: "outbound:connection/request:req-wrong-nonce",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: PEER_AGENT.agentId,
			status: "acked",
		});

		const wrongNonceResult = buildConnectionResult({
			requestId: "req-wrong-nonce",
			requestNonce: "unexpected-nonce",
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			to: { agentId: 1, chain: "eip155:84532" },
			status: "accepted",
			connectionId: pendingContact.connectionId,
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-wrong-nonce",
				message: wrongNonceResult,
			}),
		).rejects.toThrow("unexpected pending nonce");

		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("pending");
		expect((await requestJournal.getByRequestId("req-wrong-nonce"))?.status).toBe("acked");
	});

	it("rejects permission updates that do not involve the local agent", async () => {
		const contact: Contact = {
			connectionId: "conn-grants-invalid",
			peerAgentId: PEER_AGENT.agentId,
			peerChain: PEER_AGENT.chain,
			peerOwnerAddress: PEER_AGENT.ownerAddress,
			peerDisplayName: PEER_AGENT.registrationFile.name,
			peerAgentAddress: PEER_AGENT.agentAddress,
			permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
			establishedAt: "2026-03-08T00:00:00.000Z",
			lastContactAt: "2026-03-08T00:00:00.000Z",
			status: "active",
		};
		const trustStore = createMemoryTrustStore([contact]);
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();

		const invalidUpdate = buildPermissionsUpdate({
			grantSet: {
				version: "tap-grants/v1",
				updatedAt: "2026-03-08T00:00:00.000Z",
				grants: [
					{
						grantId: "invalid",
						scope: "general-chat",
						updatedAt: "2026-03-08T00:00:00.000Z",
						status: "active",
					},
				],
			},
			grantor: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			grantee: { agentId: 999, chain: PEER_AGENT.chain },
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-invalid-grants",
				message: invalidUpdate,
			}),
		).rejects.toThrow("local agent exactly once");

		const nextContact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(nextContact?.permissions.grantedByPeer.grants).toEqual([]);
	});
});
