import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportError, ValidationError } from "../../../src/common/errors.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import { buildConnectionRequest } from "../../../src/connection/handshake.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { createEmptyPermissionState } from "../../../src/permissions/types.js";
import {
	buildOutgoingActionRequest,
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
});
