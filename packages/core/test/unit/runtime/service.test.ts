import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
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
import { parseSchedulingActionResponse } from "../../../src/scheduling/index.js";
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

	public readonly sentMessages: Array<{
		peerId: number;
		message: ProtocolMessage;
		options?: TransportSendOptions;
	}> = [];

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

	async send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<TransportReceipt> {
		this.sentMessages.push({
			peerId,
			message,
			...(options ? { options } : {}),
		});
		if (this.options.sendError) {
			throw this.options.sendError;
		}
		return {
			received: true,
			requestId: String(message.id),
			status: options?.waitForAck === false ? "published" : "received",
			receivedAt: "2026-03-07T00:00:00.000Z",
		};
	}
}

const PEER_AGENT: ResolvedAgent = {
	agentId: 10,
	chain: "eip155:8453",
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

async function submitConnectionRequest(
	transport: FakeTransport,
	senderInboxId: string,
	agentId = 1,
): Promise<ProtocolMessage> {
	const { invite } = await generateInvite({
		agentId,
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

function makeActiveContact(connectionId: string): Contact {
	return {
		connectionId,
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
	const transport = dependencies.transport ?? new FakeTransport(options);
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
			ownerLabel: "tap:test-service",
			hooks: dependencies.hooks,
			...(dependencies.serviceOptions ?? {}),
		},
	);

	return { service, transport, requestJournal, dataDir };
}

describe("TapMessagingService", () => {
	it("uses a scoped transport session for syncOnce", async () => {
		const { service, transport } = await createService({ reconcileProcessed: 3 });

		const report = await service.syncOnce();

		expect(report).toEqual({
			synced: true,
			processed: 3,
			pendingRequests: [],
			pendingDeliveries: [],
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
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport({
			sendError: new TransportError("Response timeout for message result-1"),
		});
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-manual-resolve");

		await sleep(50);
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				status: "active",
			}),
		);
		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]?.message.method).toBe("connection/result");
		expect(
			await requestJournal.getByRequestId(String(transport.sentMessages[0]!.message.id)),
		).toEqual(
			expect.objectContaining({
				direction: "outbound",
				kind: "result",
				method: "connection/result",
				status: "pending",
				correlationId: String(request.id),
			}),
		);

		await service.stop();
	});

	it("retries pending connection result delivery during maintenance", async () => {
		const trustStore = createMemoryTrustStore();

		class FlakyConnectionResultTransport extends FakeTransport {
			private failConnectionResultOnce = true;

			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({
					peerId,
					message,
				});
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
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-connection-result-retry");

		await sleep(50);

		const firstConnectionResult = transport.sentMessages.find(
			(entry) => entry.message.method === "connection/result",
		);
		expect(firstConnectionResult).toBeDefined();
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				status: "active",
			}),
		);
		expect(
			(await requestJournal.getByRequestId(String(firstConnectionResult!.message.id)))?.status,
		).toBe("pending");

		await service.syncOnce();

		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "connection/result"),
		).toHaveLength(2);
		expect(await requestJournal.getByRequestId(String(firstConnectionResult!.message.id))).toEqual(
			expect.objectContaining({
				status: "completed",
				correlationId: String(request.id),
			}),
		);

		await service.stop();
	});

	it("retries pending inbound connection requests during maintenance", async () => {
		const baseTrustStore = createMemoryTrustStore();
		let failAddContactOnce = true;
		const trustStore: ITrustStore = {
			...baseTrustStore,
			addContact: async (contact) => {
				if (failAddContactOnce) {
					failAddContactOnce = false;
					throw new Error("temporary trust store failure");
				}
				await baseTrustStore.addContact(contact);
			},
		};
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-retry-connection-request");

		await sleep(50);

		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				direction: "inbound",
				kind: "request",
				method: "connection/request",
				status: "pending",
			}),
		);
		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "connection/result"),
		).toHaveLength(0);

		const report = await service.syncOnce();

		expect(report.processed).toBe(1);
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				status: "active",
			}),
		);
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "connection/result"),
		).toHaveLength(1);

		await service.stop();
	});

	it("does not report connection result delivery failure when retry persistence fails", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const logs: string[] = [];
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
				hooks: {
					log: (level, message) => {
						logs.push(`${level}:${message}`);
					},
				},
			},
		);
		const originalPutOutbound = requestJournal.putOutbound.bind(requestJournal);
		vi.spyOn(requestJournal, "putOutbound").mockImplementation(async (entry) => {
			if (entry.kind === "result" && entry.method === "connection/result") {
				throw new Error("disk full");
			}
			return await originalPutOutbound(entry);
		});

		await service.start();
		await submitConnectionRequest(transport, "peer-inbox-connection-result-persist-fail");

		await sleep(50);

		const sentResult = transport.sentMessages.find(
			(entry) => entry.message.method === "connection/result",
		);
		expect(sentResult).toBeDefined();
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				status: "active",
			}),
		);
		expect(await requestJournal.getByRequestId(String(sentResult!.message.id))).toBeNull();
		expect(
			logs.some((entry) =>
				entry.includes("Failed to persist retry metadata for connection result"),
			),
		).toBe(true);
		expect(logs.some((entry) => entry.includes("Failed to deliver connection result"))).toBe(false);

		await service.stop();
	});

	it("rejects inbound connection requests whose invite targets a different agent", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		await submitConnectionRequest(transport, "peer-inbox-connection-retry", 2);

		await sleep(50);
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
		const rejection = transport.sentMessages[0]?.message;
		expect(rejection?.method).toBe("connection/result");
		expect((rejection?.params as { status?: string; reason?: string } | undefined)?.status).toBe(
			"rejected",
		);
		expect((rejection?.params as { reason?: string } | undefined)?.reason).toContain(
			"Invite does not target the local agent",
		);

		await service.stop();
	});

	it("rejects self-invites before starting transport", async () => {
		const selfAgent: ResolvedAgent = {
			...PEER_AGENT,
			agentId: 1,
			chain: "eip155:8453",
			registrationFile: {
				...PEER_AGENT.registrationFile,
				name: "Alice",
			},
		};
		const { url: selfInviteUrl } = await generateInvite({
			agentId: 1,
			chain: "eip155:8453",
			signingProvider: ALICE_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});
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
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});
		const transport = new FakeTransport({
			sendError: new TransportError("Response timeout for message connect-timeout-1"),
		});
		const { service, requestJournal, dataDir } = await createService(
			{},
			{
				transport,
			},
		);

		const result = await service.connect({ inviteUrl: url });
		const pendingFile = JSON.parse(
			await readFile(join(dataDir, "pending-connects.json"), "utf-8"),
		) as { pendingConnects?: Array<{ requestId: string; peerAgentId: number }> };

		expect(result.status).toBe("pending");
		expect(result.receipt).toBeUndefined();
		expect(result.connectionId).toBeUndefined();
		expect(
			await requestJournal.getByRequestId(String(transport.sentMessages[0]!.message.id)),
		).toBeNull();
		expect(pendingFile.pendingConnects).toEqual([
			expect.objectContaining({
				requestId: String(transport.sentMessages[0]!.message.id),
				peerAgentId: PEER_AGENT.agentId,
			}),
		]);
	});

	it("returns active when the peer accepts during the same transport session", async () => {
		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		class ImmediateAcceptTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "connection/request") {
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-immediate",
						message: buildConnectionResult({
							requestId: String(message.id),
							from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
							status: "accepted",
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
		const trustStore = createMemoryTrustStore();
		const { service, dataDir } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		const result = await service.connect({ inviteUrl: url });
		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		const pendingFile = JSON.parse(
			await readFile(join(dataDir, "pending-connects.json"), "utf-8"),
		) as { pendingConnects?: unknown[] };

		expect(result.status).toBe("active");
		expect(result.connectionId).toBe(contact?.connectionId);
		expect(contact?.status).toBe("active");
		expect(pendingFile.pendingConnects).toEqual([]);
		expect(transport.sentMessages.map((entry) => entry.message.method)).toContain(
			"connection/request",
		);
	});

	it("fails when the peer rejects during the same transport session", async () => {
		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		class ImmediateRejectTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "connection/request") {
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-rejected",
						message: buildConnectionResult({
							requestId: String(message.id),
							from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
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
		const { service, requestJournal, dataDir } = await createService(
			{},
			{
				transport,
			},
		);

		await expect(service.connect({ inviteUrl: url })).rejects.toThrow(
			"Connection rejected by Bob (#10)",
		);
		expect(
			await requestJournal.getByRequestId(String(transport.sentMessages[0]!.message.id)),
		).toBeNull();
		expect(
			JSON.parse(await readFile(join(dataDir, "pending-connects.json"), "utf-8")) as {
				pendingConnects?: unknown[];
			},
		).toEqual({ pendingConnects: [] });
	});

	it("ignores unsolicited connection results that do not match a pending outbound request", async () => {
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

		const staleRejectedResult = buildConnectionResult({
			requestId: "req-stale-1",
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
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
		).resolves.toEqual({ status: "duplicate" });

		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
		expect(await requestJournal.getByRequestId("req-stale-1")).toBeNull();
	});

	it("processes queued outbound commands during syncOnce", async () => {
		const activeContact = makeActiveContact("conn-message-1");
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
			signingProvider: BOB_SIGNING_PROVIDER,
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
		const activeContact = makeActiveContact("conn-grants-1");
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
		const activeContact = makeActiveContact("conn-request-funds-fast");

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
			chain: "eip155:8453",
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
		const contact = makeActiveContact("conn-transfer-retry");

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
					approveTransfer: async () => true,
					executeTransfer: vi.fn(async () => ({
						txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
					})),
				},
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
				chain: "eip155:8453",
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

	it("auto-approves grant-covered transfer when no approveTransfer hook is registered", async () => {
		const contact: Contact = {
			...makeActiveContact("conn-manual-transfer-1"),
			permissions: {
				...createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
				grantedByMe: createGrantSet(
					[
						{
							grantId: "manual-transfer-approval",
							scope: "transfer/request",
							constraints: {
								asset: "native",
								chain: "eip155:8453",
								toAddress: ALICE.address,
								maxAmount: "1",
							},
						},
					],
					"2026-03-08T00:00:00.000Z",
				),
			},
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
				chain: "eip155:8453",
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

		// Grant-covered transfer should be auto-approved without needing resolvePending
		expect(await service.listPendingRequests()).toEqual([]);
		expect(executeTransfer).toHaveBeenCalledOnce();
		expect((await requestJournal.getByRequestId(String(request.id)))?.status).toBe("completed");

		const actionResult = transport.sentMessages.find(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResult).toBeDefined();
		expect(parseTransferActionResponse(actionResult!.message)?.status).toBe("completed");

		await service.stop();
	});

	it("marks executed transfer requests completed even if retry metadata persistence fails", async () => {
		const contact = makeActiveContact("conn-transfer-journal-fail");
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const,
		}));
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { approveTransfer: async () => true, executeTransfer },
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
				chain: "eip155:8453",
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

	it("rejects transfer without matching grants when no approveTransfer hook is registered", async () => {
		const contact = makeActiveContact("conn-transfer-no-hook");
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
		}));
		const transport = new FakeTransport();
		const { service } = await createService(
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
				actionId: "transfer-action-no-hook",
				asset: "native",
				amount: "0.1",
				chain: "eip155:8453",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-no-hook",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await service.stop();

		expect(executeTransfer).not.toHaveBeenCalled();
		const result = parseTransferActionResponse(transport.sentMessages[0]!.message);
		expect(transport.sentMessages[0]?.message.method).toBe("action/result");
		expect(result?.status).toBe("rejected");
	});

	it("leaves transfer pending when approveTransfer hook returns null and no grants match", async () => {
		const contact = makeActiveContact("conn-transfer-hook-null");
		const approveTransfer = vi.fn(async () => null);
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
				actionId: "transfer-hook-null-1",
				asset: "native",
				amount: "0.1",
				chain: "eip155:8453",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-hook-null",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		expect(approveTransfer).toHaveBeenCalledOnce();
		expect(executeTransfer).not.toHaveBeenCalled();
		expect(await service.listPendingRequests()).toEqual([
			expect.objectContaining({
				requestId: String(request.id),
				method: "action/request",
				peerAgentId: PEER_AGENT.agentId,
			}),
		]);
		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(0);

		await service.stop();
	});

	it("allows hook-based transfer approval without matching grants", async () => {
		const contact = makeActiveContact("conn-transfer-2");
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
		}));
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { approveTransfer: async () => true, executeTransfer },
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
				chain: "eip155:8453",
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
		const contact = makeActiveContact("conn-request-funds-fast");

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
			chain: "eip155:8453",
			toAddress: ALICE.address,
		});

		expect(result.asyncResult).toEqual(
			expect.objectContaining({
				status: "completed",
				actionId: expect.any(String),
			}),
		);
	});

	it("rejects connection results from a different peer than the pending outbound request", async () => {
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();
		const { service, requestJournal, dataDir } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		await writeFile(
			join(dataDir, "pending-connects.json"),
			JSON.stringify(
				{
					pendingConnects: [
						{
							requestId: "req-wrong-peer",
							peerAgentId: PEER_AGENT.agentId,
							peerChain: PEER_AGENT.chain,
							peerOwnerAddress: PEER_AGENT.ownerAddress,
							peerDisplayName: PEER_AGENT.registrationFile.name,
							peerAgentAddress: PEER_AGENT.agentAddress,
							createdAt: "2026-03-08T00:00:00.000Z",
						},
					],
				},
				null,
				"\t",
			),
			"utf-8",
		);

		const wrongNonceResult = buildConnectionResult({
			requestId: "req-wrong-peer",
			from: { agentId: 999, chain: PEER_AGENT.chain },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: 999,
				senderInboxId: "peer-inbox-wrong-peer",
				message: wrongNonceResult,
			}),
		).rejects.toThrow("sender does not match the pending connect");

		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
		expect(await requestJournal.getByRequestId("req-wrong-peer")).toBeNull();
	});

	it("rejects permission updates that do not involve the local agent", async () => {
		const contact = makeActiveContact("conn-grants-invalid");
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

	it("defers connection request when approveConnection hook returns null", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const approveConnection = vi.fn(async () => null);
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
				hooks: { approveConnection },
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-defer-connection");

		await sleep(50);

		expect(approveConnection).toHaveBeenCalledOnce();
		expect(approveConnection).toHaveBeenCalledWith({
			peerAgentId: PEER_AGENT.agentId,
			peerName: PEER_AGENT.registrationFile.name,
			peerChain: PEER_AGENT.chain,
		});
		// No connection/result should have been sent
		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "connection/result"),
		).toHaveLength(0);
		// No contact should have been created
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
		// Journal entry should still be pending (NOT completed)
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				direction: "inbound",
				kind: "request",
				method: "connection/request",
				status: "pending",
			}),
		);

		await service.stop();
	});

	it("rejects connection request when approveConnection hook returns false", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const approveConnection = vi.fn(async () => false);
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
				hooks: { approveConnection },
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-reject-connection");

		await sleep(50);

		expect(approveConnection).toHaveBeenCalledOnce();
		// A connection/result with rejected status should have been sent
		const connectionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "connection/result",
		);
		expect(connectionResults).toHaveLength(1);
		const resultParams = connectionResults[0]?.message.params as {
			status?: string;
			reason?: string;
		};
		expect(resultParams?.status).toBe("rejected");
		expect(resultParams?.reason).toContain("declined by operator");
		// No contact should have been created
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
		// Journal entry should be completed
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		await service.stop();
	});

	it("accepts connection request when approveConnection hook returns true", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const approveConnection = vi.fn(async () => true);
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
				hooks: { approveConnection },
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-accept-connection");

		await sleep(50);

		expect(approveConnection).toHaveBeenCalledOnce();
		// An accepted connection/result should have been sent
		const connectionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "connection/result",
		);
		expect(connectionResults).toHaveLength(1);
		const resultParams = connectionResults[0]?.message.params as { status?: string };
		expect(resultParams?.status).toBe("accepted");
		// Contact should have been created
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				status: "active",
			}),
		);
		// Journal entry should be completed
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		await service.stop();
	});

	it("auto-accepts connection request when no approveConnection hook is registered", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
				// No hooks — default behavior
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-auto-accept-connection");

		await sleep(50);

		// Contact should have been created (auto-accept)
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				status: "active",
			}),
		);
		// Journal entry should be completed
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		await service.stop();
	});

	it.each([
		["approves", true, "accepted"],
		["rejects", false, "rejected"],
	] as const)(
		"resolvePending %s a deferred connection request",
		async (_, approve, expectedStatus) => {
			const trustStore = createMemoryTrustStore();
			const transport = new FakeTransport();
			const approveConnection = vi.fn(async () => null);
			const { service, requestJournal } = await createService(
				{},
				{
					transport,
					trustStore,
					hooks: { approveConnection },
				},
			);

			await service.start();
			const request = await submitConnectionRequest(
				transport,
				`peer-inbox-resolve-${approve ? "approve" : "reject"}-connection`,
			);

			await sleep(50);

			// Verify it's deferred
			expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
				expect.objectContaining({
					status: "pending",
					method: "connection/request",
				}),
			);

			const report = await service.resolvePending(String(request.id), approve);

			expect(report.pendingRequests).toEqual([]);
			if (approve) {
				expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
					expect.objectContaining({ status: "active" }),
				);
			} else {
				expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
			}
			expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
				expect.objectContaining({ status: "completed" }),
			);
			const connectionResults = transport.sentMessages.filter(
				(entry) => entry.message.method === "connection/result",
			);
			expect(connectionResults).toHaveLength(1);
			const resultParams = connectionResults[0]?.message.params as {
				status?: string;
				reason?: string;
			};
			expect(resultParams?.status).toBe(expectedStatus);
			if (!approve) {
				expect(resultParams?.reason).toContain("declined by operator");
			}

			await service.stop();
		},
	);

	it("resolvePending scheduling approval applies override and bypasses confirm hook", async () => {
		const contact = makeActiveContact("conn-deferred-scheduling");
		const transport = new FakeTransport();
		const confirmMeeting = vi.fn(async () => false);
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({ action: "defer" as const })),
			handleAccept: vi.fn(async () => ({ eventId: "evt-override-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { confirmMeeting },
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();

		const proposal = {
			type: "scheduling/propose",
			schedulingId: "sch-override-1",
			title: "Architecture Review",
			duration: 60,
			slots: [{ start: "2026-03-08T16:00:00.000Z", end: "2026-03-08T17:00:00.000Z" }],
			originTimezone: "UTC",
		};
		const request = buildOutgoingActionRequest(
			contact,
			"Scheduling proposal",
			proposal,
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-scheduling-override",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "pending",
			}),
		);

		const report = await service.resolvePending(String(request.id), true);
		expect(report.pendingRequests).toEqual([]);
		expect(confirmMeeting).not.toHaveBeenCalled();
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		expect(parseSchedulingActionResponse(actionResults[0]!.message)).toEqual(
			expect.objectContaining({
				type: "scheduling/accept",
				schedulingId: "sch-override-1",
			}),
		);

		await service.stop();
	});

	it("settles scheduling requests when confirmMeeting returns false", async () => {
		const contact: Contact = {
			...makeActiveContact("conn-confirm-false-scheduling"),
			permissions: {
				...createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
				grantedByMe: createGrantSet(
					[
						{
							grantId: "sched-grant-1",
							scope: "scheduling/request",
						},
					],
					"2026-03-08T00:00:00.000Z",
				),
			},
		};
		const transport = new FakeTransport();
		const confirmMeeting = vi.fn(async () => false);
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({
				action: "confirm" as const,
				slot: { start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" },
				proposal: {
					type: "scheduling/propose",
					schedulingId: "sch-confirm-false-1",
					title: "Weekly Sync",
					duration: 60,
					slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
					originTimezone: "UTC",
				},
			})),
			handleAccept: vi.fn(async () => ({ eventId: "evt-should-not-run" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { confirmMeeting },
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Scheduling proposal",
			{
				type: "scheduling/propose",
				schedulingId: "sch-confirm-false-1",
				title: "Weekly Sync",
				duration: 60,
				slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
				originTimezone: "UTC",
			},
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-confirm-false",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);
		expect(confirmMeeting).toHaveBeenCalledOnce();
		expect(schedulingHandler.handleAccept).not.toHaveBeenCalled();
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		expect(parseSchedulingActionResponse(actionResults[0]!.message)).toEqual(
			expect.objectContaining({
				type: "scheduling/reject",
				schedulingId: "sch-confirm-false-1",
			}),
		);

		await service.stop();
	});

	it("cancels outbound scheduling requests with a scheduling/cancel response", async () => {
		const contact = makeActiveContact("conn-cancel-outbound-scheduling");
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-cancel-1",
			title: "Cancel Candidate",
			duration: 45,
			slots: [{ start: "2026-03-08T20:00:00.000Z", end: "2026-03-08T20:45:00.000Z" }],
			originTimezone: "UTC",
		};
		const requestResult = await service.requestMeeting({
			peer: contact.peerDisplayName,
			proposal,
		});

		const report = await service.cancelPendingSchedulingRequest(
			String(requestResult.receipt.requestId),
			"Need to reschedule",
		);
		expect(report.pendingRequests).toEqual([]);
		expect(await requestJournal.getByRequestId(String(requestResult.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		expect(parseSchedulingActionResponse(actionResults[0]!.message)).toEqual({
			type: "scheduling/cancel",
			schedulingId: "sch-cancel-1",
			reason: "Need to reschedule",
		});

		await service.stop();
	});

	it("completes the superseded outbound request when a counter-proposal arrives", async () => {
		const contact = makeActiveContact("conn-counter-cleanup");
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-counter-1",
			title: "Counter Candidate",
			duration: 45,
			slots: [{ start: "2026-03-08T20:00:00.000Z", end: "2026-03-08T20:45:00.000Z" }],
			originTimezone: "UTC",
		};
		const meeting = await service.requestMeeting({ peer: contact.peerDisplayName, proposal });

		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "acked",
			}),
		);

		const counter = buildOutgoingActionRequest(
			contact,
			"Counter proposal",
			{
				...proposal,
				type: "scheduling/counter" as const,
				slots: [{ start: "2026-03-09T20:00:00.000Z", end: "2026-03-09T20:45:00.000Z" }],
			},
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-counter-cleanup",
				message: counter,
			}),
		).resolves.toEqual({ status: "queued" });

		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
		expect(await service.listPendingRequests()).toEqual([
			expect.objectContaining({
				requestId: String(counter.id),
				direction: "inbound",
			}),
		]);

		await service.stop();
	});

	it("uses the responder's local timezone and stores the local event when accepting", async () => {
		const contact: Contact = {
			...makeActiveContact("conn-responder-timezone"),
			permissions: {
				...createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
				grantedByMe: createGrantSet(
					[
						{
							grantId: "sched-grant-1",
							scope: "scheduling/request",
						},
					],
					"2026-03-08T00:00:00.000Z",
				),
			},
		};
		const transport = new FakeTransport();
		const confirmMeeting = vi.fn(async () => true);
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({
				action: "confirm" as const,
				slot: { start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" },
				proposal: {
					type: "scheduling/propose",
					schedulingId: "sch-responder-tz-1",
					title: "Local Timezone Review",
					duration: 60,
					slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
					originTimezone: "America/New_York",
				},
			})),
			handleAccept: vi.fn(async () => ({ eventId: "evt-responder-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const dateTimeFormatSpy = vi
			.spyOn(Intl, "DateTimeFormat")
			.mockReturnValue({ resolvedOptions: () => ({ timeZone: "America/Los_Angeles" }) } as never);
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { confirmMeeting },
				serviceOptions: { schedulingHandler },
			},
		);

		try {
			await service.start();

			const request = buildOutgoingActionRequest(
				contact,
				"Scheduling proposal",
				{
					type: "scheduling/propose",
					schedulingId: "sch-responder-tz-1",
					title: "Local Timezone Review",
					duration: 60,
					slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
					originTimezone: "America/New_York",
				},
				"scheduling/request",
			);

			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-responder-timezone",
					message: request,
				}),
			).resolves.toEqual({ status: "queued" });

			await sleep(50);
			expect(schedulingHandler.handleAccept).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "scheduling/accept",
					schedulingId: "sch-responder-tz-1",
				}),
				contact.peerDisplayName,
				"Local Timezone Review",
				"America/Los_Angeles",
			);
			expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
				expect.objectContaining({
					status: "completed",
					metadata: expect.objectContaining({
						localEventId: "evt-responder-1",
						schedulingState: "accepted",
					}),
				}),
			);
		} finally {
			dateTimeFormatSpy.mockRestore();
			await service.stop();
		}
	});

	it("deletes the requester's local calendar event when the peer cancels an accepted meeting", async () => {
		const contact = makeActiveContact("conn-requester-cancel-cleanup");
		const transport = new FakeTransport();
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({ action: "defer" as const })),
			handleAccept: vi.fn(async () => ({ eventId: "evt-requester-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-requester-cancel-1",
			title: "Requester Cleanup",
			duration: 45,
			slots: [{ start: "2026-03-08T20:00:00.000Z", end: "2026-03-08T20:45:00.000Z" }],
			originTimezone: "UTC",
		};
		const meeting = await service.requestMeeting({ peer: contact.peerDisplayName, proposal });

		const accept = buildOutgoingActionResult(
			contact,
			String(meeting.receipt.requestId),
			"Accepted",
			{
				type: "scheduling/accept",
				schedulingId: proposal.schedulingId,
				acceptedSlot: proposal.slots[0],
			},
			"scheduling/request",
			"completed",
		);
		await expect(
			transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-requester-accept",
				message: accept,
			}),
		).resolves.toEqual({ status: "received" });

		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					localEventId: "evt-requester-1",
					schedulingState: "accepted",
				}),
			}),
		);

		const cancel = buildOutgoingActionResult(
			contact,
			String(meeting.receipt.requestId),
			"Cancelled",
			{
				type: "scheduling/cancel",
				schedulingId: proposal.schedulingId,
				reason: "Need to reschedule",
			},
			"scheduling/request",
			"rejected",
		);
		await expect(
			transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-requester-cancel",
				message: cancel,
			}),
		).resolves.toEqual({ status: "received" });

		expect(schedulingHandler.handleCancel).toHaveBeenCalledWith("evt-requester-1");
		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "completed",
				metadata: expect.objectContaining({
					schedulingState: "cancelled",
				}),
			}),
		);
		expect(
			(await requestJournal.getByRequestId(String(meeting.receipt.requestId)))?.metadata,
		).not.toHaveProperty("localEventId");

		await service.stop();
	});

	it("deletes the responder's local calendar event when the requester cancels later", async () => {
		const contact: Contact = {
			...makeActiveContact("conn-responder-cancel-cleanup"),
			permissions: {
				...createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
				grantedByMe: createGrantSet(
					[
						{
							grantId: "sched-grant-1",
							scope: "scheduling/request",
						},
					],
					"2026-03-08T00:00:00.000Z",
				),
			},
		};
		const transport = new FakeTransport();
		const confirmMeeting = vi.fn(async () => true);
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({
				action: "confirm" as const,
				slot: { start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" },
				proposal: {
					type: "scheduling/propose",
					schedulingId: "sch-responder-cancel-1",
					title: "Responder Cleanup",
					duration: 60,
					slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
					originTimezone: "UTC",
				},
			})),
			handleAccept: vi.fn(async () => ({ eventId: "evt-responder-cancel-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { confirmMeeting },
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Scheduling proposal",
			{
				type: "scheduling/propose",
				schedulingId: "sch-responder-cancel-1",
				title: "Responder Cleanup",
				duration: 60,
				slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
				originTimezone: "UTC",
			},
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-responder-cancel",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					localEventId: "evt-responder-cancel-1",
					schedulingState: "accepted",
				}),
			}),
		);

		const cancel = buildOutgoingActionResult(
			contact,
			String(request.id),
			"Cancelled",
			{
				type: "scheduling/cancel",
				schedulingId: "sch-responder-cancel-1",
				reason: "Need to reschedule",
			},
			"scheduling/request",
			"rejected",
		);
		await expect(
			transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-responder-cancel-result",
				message: cancel,
			}),
		).resolves.toEqual({ status: "received" });

		expect(schedulingHandler.handleCancel).toHaveBeenCalledWith("evt-responder-cancel-1");
		expect((await requestJournal.getByRequestId(String(request.id)))?.metadata).not.toHaveProperty(
			"localEventId",
		);
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					schedulingState: "cancelled",
				}),
			}),
		);

		await service.stop();
	});

	it("uses outbound scheduling metadata for accepted meeting title and timezone", async () => {
		const contact = makeActiveContact("conn-scheduling-accept-metadata");
		const transport = new FakeTransport();
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({ action: "defer" as const })),
			handleAccept: vi.fn(async () => ({ eventId: "evt-accept-meta-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-meta-1",
			title: "Backend Roadmap",
			duration: 30,
			slots: [{ start: "2026-03-08T12:00:00.000Z", end: "2026-03-08T12:30:00.000Z" }],
			originTimezone: "America/New_York",
		};
		const meeting = await service.requestMeeting({ peer: contact.peerDisplayName, proposal });

		const accept = buildOutgoingActionResult(
			contact,
			String(meeting.receipt.requestId),
			"Accepted",
			{
				type: "scheduling/accept",
				schedulingId: proposal.schedulingId,
				acceptedSlot: proposal.slots[0],
			},
			"scheduling/request",
			"completed",
		);
		await expect(
			transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-accept-meta",
				message: accept,
			}),
		).resolves.toEqual({ status: "received" });

		expect(schedulingHandler.handleAccept).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "scheduling/accept",
				schedulingId: "sch-meta-1",
			}),
			contact.peerDisplayName,
			"Backend Roadmap",
			"America/New_York",
		);
		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		await service.stop();
	});

	it("does not crash when emitEvent hook throws", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const emitEvent = vi.fn(() => {
			throw new Error("boom from emitEvent");
		});
		const log = vi.fn();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore,
				hooks: { emitEvent, log },
			},
		);

		await service.start();
		// Should not throw even though emitEvent hook throws
		await submitConnectionRequest(transport, "peer-inbox-emit-crash");

		expect(emitEvent).toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"warn",
			expect.stringContaining("emitEvent hook threw: boom from emitEvent"),
		);

		await service.stop();
	});

	it("resolvePending rejects non-connection and non-action requests", async () => {
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		// Manually insert a message/send journal entry to simulate a non-resolvable request
		await requestJournal.claimInbound({
			requestId: "msg-send-123",
			requestKey: "test:message/send:msg-send-123",
			direction: "inbound",
			kind: "request",
			method: "message/send",
			peerAgentId: PEER_AGENT.agentId,
		});

		await expect(service.resolvePending("msg-send-123", true)).rejects.toThrow(
			"cannot be resolved manually",
		);
	});

	it("sends UNSUPPORTED_ACTION error for unrecognized action types", async () => {
		const contact = makeActiveContact("conn-unsupported-action");
		const emitEvent = vi.fn();
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { emitEvent },
			},
		);

		await service.start();

		// Build an action/request with an unrecognized type
		const request = buildOutgoingActionRequest(
			contact,
			"Do something exotic",
			{
				type: "exotic/unknown-action",
				actionId: "exotic-1",
				foo: "bar",
			},
			"exotic/unknown-action",
		);

		const result = await transport.handlers.onRequest?.({
			from: contact.peerAgentId,
			senderInboxId: "peer-inbox-unsupported",
			message: request,
		});

		expect(result).toEqual({ status: "received" });

		// Should have sent an action/result with UNSUPPORTED_ACTION error
		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		const resultParams = actionResults[0].message.params as {
			status?: string;
			message?: { parts?: Array<{ kind: string; data?: Record<string, unknown>; text?: string }> };
		};
		expect(resultParams.status).toBe("failed");

		// Check the data part contains the UNSUPPORTED_ACTION error
		const dataPart = resultParams.message?.parts?.find((p) => p.kind === "data");
		expect(dataPart?.data).toEqual(
			expect.objectContaining({
				error: expect.objectContaining({
					code: "UNSUPPORTED_ACTION",
				}),
			}),
		);

		// Check the emitEvent was called with the error info
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				error: "UNSUPPORTED_ACTION",
				actionType: "exotic/unknown-action",
			}),
		);

		await service.stop();
	});

	it("sendActionRequest persists to request journal", async () => {
		const contact = makeActiveContact("conn-action-journal");
		const { service, transport, requestJournal } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();

		await service.sendActionRequest(
			{ connectionId: contact.connectionId },
			"bet/propose",
			{ odds: 1.5, amount: "100" },
			"Proposing a bet",
		);

		// Verify the request was sent
		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]!.message.method).toBe("action/request");

		const requestId = String(transport.sentMessages[0]!.message.id);

		// Verify journal entry was created and acked
		const entry = await requestJournal.getByRequestId(requestId);
		expect(entry).not.toBeNull();
		expect(entry!.direction).toBe("outbound");
		expect(entry!.kind).toBe("request");
		expect(entry!.method).toBe("action/request");
		expect(entry!.peerAgentId).toBe(PEER_AGENT.agentId);
		expect(entry!.status).toBe("acked");
		expect(entry!.metadata).toEqual({ actionType: "bet/propose" });

		await service.stop();
	});

	it("sendActionRequest cleans up journal on non-timeout send failure", async () => {
		const contact = makeActiveContact("conn-action-journal-fail");
		const { service, requestJournal } = await createService(
			{ sendError: new Error("network failure") },
			{
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();

		await expect(
			service.sendActionRequest({ connectionId: contact.connectionId }, "bet/propose", {
				odds: 1.5,
			}),
		).rejects.toThrow("network failure");

		// Journal should be cleaned up after non-timeout failure
		const entries = await requestJournal.list("outbound");
		expect(entries).toHaveLength(0);

		await service.stop();
	});

	it("emits structured event for generic (non-transfer, non-scheduling) action result", async () => {
		const contact = makeActiveContact("conn-generic-result");
		const emitEvent = vi.fn();
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { emitEvent },
			},
		);

		await service.start();

		// Simulate an outbound action request to create a journal entry
		await service.sendActionRequest(
			{ connectionId: contact.connectionId },
			"bet/propose",
			{ odds: 1.5, matchId: "match-42" },
			"Proposing a bet",
		);

		const outboundRequestId = String(transport.sentMessages[0]!.message.id);

		// Build a generic action result (not transfer, not scheduling)
		const resultMessage = buildOutgoingActionResult(
			contact,
			outboundRequestId,
			"Bet accepted",
			{
				type: "bet/accept",
				betId: "bet-123",
				accepted: true,
			},
			"bet/propose",
			"completed",
		);

		// Deliver the result via onResult handler
		const result = await transport.handlers.onResult?.({
			from: contact.peerAgentId,
			senderInboxId: "peer-inbox-generic",
			message: resultMessage,
		});

		expect(result).toEqual({ status: "received" });

		// Verify structured event was emitted for the generic result
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "action_result_received",
				method: "action/result",
				actionType: "bet/accept",
				peerAgentId: PEER_AGENT.agentId,
				peerName: PEER_AGENT.registrationFile.name,
				connectionId: contact.connectionId,
				requestId: outboundRequestId,
				data: expect.objectContaining({
					type: "bet/accept",
					betId: "bet-123",
					accepted: true,
				}),
			}),
		);

		// Verify the outbound journal entry was completed
		const entry = await requestJournal.getByRequestId(outboundRequestId);
		expect(entry).not.toBeNull();
		expect(entry!.status).toBe("completed");

		await service.stop();
	});

	it("handles generic action result without a correlated outbound request", async () => {
		const contact = makeActiveContact("conn-generic-no-journal");
		const emitEvent = vi.fn();
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { emitEvent },
			},
		);

		await service.start();

		// Build a generic action result with no corresponding outbound request
		const resultMessage = buildOutgoingActionResult(
			contact,
			"nonexistent-request-id",
			"Unsolicited result",
			{
				type: "custom/notification",
				payload: { status: "ok" },
			},
			"custom/notification",
			"completed",
		);

		const result = await transport.handlers.onResult?.({
			from: contact.peerAgentId,
			senderInboxId: "peer-inbox-unsolicited",
			message: resultMessage,
		});

		expect(result).toEqual({ status: "received" });

		// Should still emit the event even without a journal entry
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "action_result_received",
				actionType: "custom/notification",
				peerAgentId: PEER_AGENT.agentId,
				data: expect.objectContaining({
					type: "custom/notification",
				}),
			}),
		);

		await service.stop();
	});

	describe("messaging fire-and-forget semantics", () => {
		it("sendMessage publishes without waiting for an application-level ack", async () => {
			const activeContact = makeActiveContact("conn-fire-and-forget");
			const loggedMessages: Array<{
				conversationId: string;
				direction: string;
				content: unknown;
			}> = [];
			const conversationLogger: IConversationLogger = {
				logMessage: async (conversationId, message) => {
					loggedMessages.push({
						conversationId,
						direction: message.direction,
						content: message.content,
					});
				},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
			};

			// Custom transport that NEVER sends a transport-level ack back —
			// simulates a peer that's not listening (one-shot CLI scenario).
			// Before the fix, sendMessage would rely on the JSON-RPC receipt
			// coming back and throw "Response timeout" if the peer is offline.
			class SilentTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					// Intentionally return "published" — this is what the transport
					// MUST do when waitForAck:false so the caller doesn't block.
					return {
						received: true,
						requestId: String(message.id),
						status: "published",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}

			const transport = new SilentTransport();
			const dataDir = await mkdtemp(join(tmpdir(), "tap-fire-and-forget-"));
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
			const appRegistry = new TapAppRegistry(dataDir);
			const service = new TapMessagingService(
				{
					config,
					signingProvider: ALICE_SIGNING_PROVIDER,
					trustStore: createMemoryTrustStore([activeContact]),
					resolver: createStaticResolver(),
					conversationLogger,
					requestJournal,
					transport,
					appRegistry,
				},
				{
					ownerLabel: "tap:test-fire-and-forget",
				},
			);

			const result = await service.sendMessage(activeContact.peerDisplayName, "Hello Bob");

			// 1. It did not throw. (Before: would throw "Response timeout".)
			expect(result.receipt.status).toBe("published");

			// 2. Transport.send was invoked with waitForAck: false.
			expect(transport.sentMessages).toHaveLength(1);
			expect(transport.sentMessages[0]?.message.method).toBe("message/send");
			expect(transport.sentMessages[0]?.options?.waitForAck).toBe(false);

			// 3. Conversation log was written immediately after publication —
			//    even though no ack ever arrived.
			expect(loggedMessages).toHaveLength(1);
			expect(loggedMessages[0]?.direction).toBe("outgoing");
		});

		it("writes conversation log for outgoing messages on successful publication", async () => {
			const activeContact = makeActiveContact("conn-eager-log");
			const loggedMessages: Array<{ direction: string }> = [];
			const conversationLogger: IConversationLogger = {
				logMessage: async (_conversationId, message) => {
					loggedMessages.push({ direction: message.direction });
				},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
			};

			const transport = new FakeTransport();
			const dataDir = await mkdtemp(join(tmpdir(), "tap-eager-log-"));
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
			const service = new TapMessagingService(
				{
					config,
					signingProvider: ALICE_SIGNING_PROVIDER,
					trustStore: createMemoryTrustStore([activeContact]),
					resolver: createStaticResolver(),
					conversationLogger,
					requestJournal: new FileRequestJournalImpl(dataDir),
					transport,
					appRegistry: new TapAppRegistry(dataDir),
				},
				{ ownerLabel: "tap:test-eager-log" },
			);

			await service.sendMessage(activeContact.peerDisplayName, "Eager log test");

			expect(loggedMessages).toEqual([{ direction: "outgoing" }]);
		});

		it("does NOT write conversation log if publication fails", async () => {
			const activeContact = makeActiveContact("conn-publish-fail");
			const loggedMessages: Array<unknown> = [];
			const conversationLogger: IConversationLogger = {
				logMessage: async () => {
					loggedMessages.push(true);
				},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
			};

			class PublishFailTransport extends FakeTransport {
				override async send(): Promise<TransportReceipt> {
					throw new TransportError("Failed to publish DM: network unreachable");
				}
			}

			const dataDir = await mkdtemp(join(tmpdir(), "tap-publish-fail-"));
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
			const service = new TapMessagingService(
				{
					config,
					signingProvider: ALICE_SIGNING_PROVIDER,
					trustStore: createMemoryTrustStore([activeContact]),
					resolver: createStaticResolver(),
					conversationLogger,
					requestJournal: new FileRequestJournalImpl(dataDir),
					transport: new PublishFailTransport(),
					appRegistry: new TapAppRegistry(dataDir),
				},
				{ ownerLabel: "tap:test-publish-fail" },
			);

			await expect(service.sendMessage(activeContact.peerDisplayName, "Will fail")).rejects.toThrow(
				"Failed to publish",
			);
			expect(loggedMessages).toHaveLength(0);
		});
	});

	describe("connection result journal idempotency", () => {
		it("reuses the same outbound journal entry when processConnectionRequest re-runs for the same inbound", async () => {
			// Scenario that reproduces the reported accumulation bug:
			// the process crashes between sendConnectionResult's putOutbound and
			// the updateStatus("completed") of the inbound entry. On restart,
			// the listener re-processes the still-pending inbound, runs
			// sendConnectionResult again, and — before the fix — creates a
			// brand-new outbound entry each time. We simulate the crash by
			// resetting the inbound status to "pending" between submissions.
			const trustStore = createMemoryTrustStore();
			class PublishFailingTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					if (message.method === "connection/result") {
						throw new TransportError("permanent publish failure for test");
					}
					return {
						received: true,
						requestId: String(message.id),
						status: options?.waitForAck === false ? "published" : "received",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}
			const transport = new PublishFailingTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			await service.start();
			const request = await submitConnectionRequest(transport, "peer-inbox-dedup");
			await sleep(50);

			// Force the inbound back to pending (simulates process crash).
			await requestJournal.updateStatus(String(request.id), "pending");

			// Re-submit the SAME inbound message — mimics the listener replaying
			// the message after restart.
			await transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-dedup",
				message: request,
			});
			await sleep(50);

			// And once more for good measure.
			await requestJournal.updateStatus(String(request.id), "pending");
			await transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-dedup",
				message: request,
			});
			await sleep(50);

			const pendingResults = (await requestJournal.listPending("outbound")).filter(
				(entry) => entry.method === "connection/result",
			);
			expect(pendingResults).toHaveLength(1);
			expect(pendingResults[0]?.correlationId).toBe(String(request.id));

			await service.stop();
		});
	});

	describe("sync report surfaces pending outbound deliveries", () => {
		it("populates pendingDeliveries with stuck outbound connection/result entries", async () => {
			const trustStore = createMemoryTrustStore();
			class PublishFailingTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					if (message.method === "connection/result") {
						throw new TransportError("publish failed: unreachable");
					}
					return {
						received: true,
						requestId: String(message.id),
						status: options?.waitForAck === false ? "published" : "received",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}
			const transport = new PublishFailingTransport();
			const { service } = await createService({}, { transport, trustStore });

			await service.start();
			const request = await submitConnectionRequest(transport, "peer-inbox-sync-report");
			await sleep(50);

			const report = await service.syncOnce();

			expect(report.pendingDeliveries).toBeDefined();
			expect(report.pendingDeliveries?.length ?? 0).toBeGreaterThan(0);
			const delivery = report.pendingDeliveries?.[0];
			expect(delivery?.method).toBe("connection/result");
			expect(delivery?.peerAgentId).toBe(PEER_AGENT.agentId);
			expect(delivery?.correlationId).toBe(String(request.id));
			expect(delivery?.lastError).toContain("publish failed");

			await service.stop();
		});
	});

	describe("implicit handshake completion on inbound traffic", () => {
		it("marks pending outbound connection/result entries completed when peer sends a valid inbound message", async () => {
			const trustStore = createMemoryTrustStore();
			class DropConnectionResultTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					if (message.method === "connection/result") {
						// Pretend publish failed so the entry stays pending.
						throw new TransportError("drop connection/result for test");
					}
					return {
						received: true,
						requestId: String(message.id),
						status: options?.waitForAck === false ? "published" : "received",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}
			const transport = new DropConnectionResultTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			await service.start();
			await submitConnectionRequest(transport, "peer-inbox-implicit-completion");
			await sleep(50);

			const pendingBefore = (await requestJournal.listPending("outbound")).filter(
				(entry) => entry.method === "connection/result",
			);
			expect(pendingBefore).toHaveLength(1);

			// Now the peer's side got our connection/result eventually and has
			// added us to its trust store. Simulate the peer sending us a plain
			// message/send, which proves they have an active contact for us —
			// our pending connection/result delivery is no longer load-bearing.
			const activeContact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
			expect(activeContact?.status).toBe("active");

			const inbound: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "peer-hello-1",
				params: {
					message: {
						parts: [{ kind: "text", text: "Thanks for connecting!" } as const],
					},
				},
			};

			await expect(
				transport.handlers.onRequest?.({
					from: PEER_AGENT.agentId,
					senderInboxId: "peer-inbox-implicit-completion",
					message: inbound,
				}),
			).resolves.toEqual(expect.objectContaining({ status: "received" }));
			await sleep(50);

			const pendingAfter = (await requestJournal.listPending("outbound")).filter(
				(entry) => entry.method === "connection/result",
			);
			expect(pendingAfter).toHaveLength(0);

			await service.stop();
		});

		it("clears the connection-result cache after the retry pipeline delivers, so subsequent inbounds don't re-scan the journal", async () => {
			// Regression for a cache-leak perf bug: if the retry pipeline
			// delivered the connection/result rather than the direct path,
			// the peer would linger in `peersWithPendingConnectionResult`
			// until the next inbound triggered a full journal scan to clear
			// it. This test proves the cache is cleared at the moment of
			// successful retry delivery instead.
			const trustStore = createMemoryTrustStore();
			let failConnectionResultOnce = true;
			class FlakyThenSucceedTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					if (message.method === "connection/result" && failConnectionResultOnce) {
						failConnectionResultOnce = false;
						throw new TransportError("first attempt fails");
					}
					return {
						received: true,
						requestId: String(message.id),
						status: options?.waitForAck === false ? "published" : "received",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}
			const transport = new FlakyThenSucceedTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			await service.start();
			await submitConnectionRequest(transport, "peer-inbox-cache-clear");
			await sleep(50);

			// First attempt failed — entry pending, cache holds the peer.
			expect(
				(await requestJournal.listPending("outbound")).some(
					(entry) => entry.method === "connection/result",
				),
			).toBe(true);

			// syncOnce triggers retryPendingConnectionResults, which now succeeds.
			const firstReport = await service.syncOnce();
			expect(firstReport.pendingDeliveries).toHaveLength(0);
			expect(
				(await requestJournal.listPending("outbound")).some(
					(entry) => entry.method === "connection/result",
				),
			).toBe(false);

			// Warm-up inbound: triggers the one-time cache priming scan,
			// which is fine and expected. We measure the NEXT inbound.
			const warmup: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "peer-warmup-after-retry",
				params: {
					message: { parts: [{ kind: "text", text: "hi 1" } as const] },
				},
			};
			await transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-cache-clear",
				message: warmup,
			});
			await sleep(20);

			// Subsequent inbound: if the cache wasn't cleared by the retry-
			// success path, `markPendingConnectionResultsCompletedFor` would
			// do a full journal scan for every following inbound from the
			// peer. After the fix, the cache miss short-circuits before
			// touching the journal.
			const listPendingSpy = vi.spyOn(requestJournal, "listPending");
			const inbound: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "peer-hello-after-retry",
				params: {
					message: { parts: [{ kind: "text", text: "hi 2" } as const] },
				},
			};
			await transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-cache-clear",
				message: inbound,
			});
			await sleep(20);

			expect(listPendingSpy).not.toHaveBeenCalled();
			listPendingSpy.mockRestore();

			await service.stop();
		});

		it("shares a single priming scan across concurrent implicit-completion callers", async () => {
			// Regression for a priming race: two concurrent inbound messages
			// could both enter the implicit-completion path and both trigger
			// full journal scans (instead of sharing one). After the fix,
			// concurrent callers await the same priming promise.
			const trustStore = createMemoryTrustStore();
			const transport = new FakeTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			await service.start();
			// Seed one pending outbound connection/result by running the
			// handshake against a transport that drops the result.
			class DropTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					if (message.method === "connection/result") {
						throw new TransportError("drop for test");
					}
					return {
						received: true,
						requestId: String(message.id),
						status: options?.waitForAck === false ? "published" : "received",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}
			const dropTransport = new DropTransport();
			dropTransport.handlers = transport.handlers;
			(service as unknown as { context: { transport: TransportProvider } }).context.transport =
				dropTransport;
			await submitConnectionRequest(dropTransport, "peer-inbox-prime-race");
			await sleep(50);

			// Restore the normal transport for subsequent sends.
			(service as unknown as { context: { transport: TransportProvider } }).context.transport =
				transport;
			transport.handlers = dropTransport.handlers;

			// Fire two concurrent inbounds that both trigger implicit
			// completion. The priming scan should run exactly once.
			const listPendingSpy = vi.spyOn(requestJournal, "listPending");
			const inbound = (id: string): ProtocolMessage => ({
				jsonrpc: "2.0",
				method: "message/send",
				id,
				params: { message: { parts: [{ kind: "text", text: id } as const] } },
			});
			await Promise.all([
				transport.handlers.onRequest?.({
					from: PEER_AGENT.agentId,
					senderInboxId: "peer-inbox-prime-race",
					message: inbound("race-1"),
				}),
				transport.handlers.onRequest?.({
					from: PEER_AGENT.agentId,
					senderInboxId: "peer-inbox-prime-race",
					message: inbound("race-2"),
				}),
			]);

			// Priming + implicit-completion scans: priming runs once. After
			// priming, each caller scans to clear the peer — which is at
			// most 2 extra calls. The race bug would have caused priming to
			// run twice (4+ calls); the fix guarantees a single shared prime.
			const primingCalls = listPendingSpy.mock.calls.filter(
				(call) => call[0] === "outbound",
			).length;
			expect(primingCalls).toBeLessThanOrEqual(3);
			listPendingSpy.mockRestore();

			await service.stop();
		});

		it("delivers legacy pending connection-result entries that were persisted before the peerChain field existed", async () => {
			// Regression: `peerChain` was added to PendingConnectionResultDelivery
			// metadata in a later commit. Entries written by earlier versions
			// lack that field. A strict parser would drop them on the floor
			// during retry and leave them stuck until the 24h stale-GC marked
			// them completed without ever delivering. The parser must accept
			// the legacy shape so retryPendingConnectionResults still calls
			// transport.send on the original request payload.
			const trustStore = createMemoryTrustStore([makeActiveContact("conn-legacy-retry")]);
			const transport = new FakeTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			// Write a legacy-shaped journal entry directly: valid in every
			// field the delivery path actually reads (peerAgentId + request
			// + peerAddress), but missing peerChain.
			const legacyRequest: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/result",
				id: "legacy-connection-result-id",
				params: {
					from: { agentId: 1, chain: "eip155:8453" },
					status: "accepted",
					requestId: "legacy-correlation-id",
				},
			};
			await requestJournal.putOutbound({
				requestId: String(legacyRequest.id),
				requestKey: `outbound:connection/result:${String(legacyRequest.id)}`,
				direction: "outbound",
				kind: "result",
				method: "connection/result",
				peerAgentId: PEER_AGENT.agentId,
				correlationId: "legacy-correlation-id",
				status: "pending",
				metadata: {
					type: "connection-result-delivery",
					peerAgentId: PEER_AGENT.agentId,
					// NOTE: deliberately no peerChain — this is the legacy shape.
					peerName: PEER_AGENT.registrationFile.name,
					peerAddress: PEER_AGENT.agentAddress,
					request: legacyRequest,
				},
			});

			await service.start();

			// syncOnce drives retryPendingConnectionResults. The legacy entry
			// must be delivered via transport.send and marked completed.
			const report = await service.syncOnce();

			expect(
				transport.sentMessages.filter((e) => e.message.method === "connection/result"),
			).toHaveLength(1);
			expect(
				(await requestJournal.listPending("outbound")).filter(
					(entry) => entry.method === "connection/result",
				),
			).toHaveLength(0);
			expect(report.pendingDeliveries).toHaveLength(0);

			await service.stop();
		});
	});
});
