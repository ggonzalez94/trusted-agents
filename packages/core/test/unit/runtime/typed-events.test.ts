import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import { buildConnectionResult } from "../../../src/connection/handshake.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { createEmptyPermissionState } from "../../../src/permissions/types.js";
import type { TapEvent } from "../../../src/runtime/event-types.js";
import { buildOutgoingActionRequest } from "../../../src/runtime/index.js";
import { FileRequestJournal } from "../../../src/runtime/request-journal.js";
import { TapMessagingService } from "../../../src/runtime/service.js";
import type { SchedulingHandler } from "../../../src/scheduling/handler.js";
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
import { jsonClone } from "../../helpers/clone.js";
import { buildRuntimeTestConfig } from "../../helpers/config.js";
import { useTempDirs } from "../../helpers/temp-dir.js";

const { track: trackTempDir } = useTempDirs();

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

function makeConnectingContact(connectionId: string): Contact {
	return {
		...makeActiveContact(connectionId),
		status: "connecting",
	};
}

function createMemoryTrustStore(initial: Contact[] = []): ITrustStore {
	const contacts = new Map(initial.map((c) => [c.connectionId, jsonClone(c)]));
	return {
		getContacts: async () => [...contacts.values()].map(jsonClone),
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
		addContact: async (c: Contact) => {
			contacts.set(c.connectionId, jsonClone(c));
		},
		updateContact: async (id: string, updates: Partial<Contact>) => {
			const existing = contacts.get(id);
			if (!existing) return;
			contacts.set(id, jsonClone({ ...existing, ...updates }));
		},
		removeContact: async (id: string) => {
			contacts.delete(id);
		},
		touchContact: async (id: string) => {
			const existing = contacts.get(id);
			if (!existing) return;
			contacts.set(id, { ...jsonClone(existing), lastContactAt: "2026-03-08T00:00:00.000Z" });
		},
	};
}

function createStaticResolver(agent: ResolvedAgent = PEER_AGENT): IAgentResolver {
	return {
		resolve: async () => agent,
		resolveWithCache: async () => agent,
	};
}

function createNoopLogger(): IConversationLogger {
	return {
		logMessage: async () => {},
		getConversation: async () => null,
		listConversations: async () => [],
		generateTranscript: async () => "",
		markRead: async () => {},
	};
}

class FakeTransport implements TransportProvider {
	public handlers: TransportHandlers = {};
	public sent: Array<{ peerId: number; message: ProtocolMessage }> = [];

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
		_options?: TransportSendOptions,
	): Promise<TransportReceipt> {
		this.sent.push({ peerId, message });
		return {
			received: true,
			requestId: String(message.id),
			status: "published",
			receivedAt: "2026-03-07T00:00:00.000Z",
		};
	}
}

interface BuiltService {
	service: TapMessagingService;
	transport: FakeTransport;
	events: TapEvent[];
	requestJournal: FileRequestJournal;
	dataDir: string;
	trustStore: ITrustStore;
}

async function buildService(options?: {
	initialContacts?: Contact[];
	approveTransfer?: (ctx: unknown) => Promise<boolean | null>;
	schedulingHandler?: SchedulingHandler;
	executeTransfer?: () => Promise<{ txHash: `0x${string}` }>;
}): Promise<BuiltService> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-typed-events-"));
	trackTempDir(dataDir);
	const config = buildRuntimeTestConfig({ dataDir });
	const transport = new FakeTransport();
	const requestJournal = new FileRequestJournal(dataDir);
	const trustStore = createMemoryTrustStore(options?.initialContacts ?? []);
	const events: TapEvent[] = [];
	const service = new TapMessagingService(
		{
			config,
			signingProvider: ALICE_SIGNING_PROVIDER,
			trustStore,
			resolver: createStaticResolver(),
			conversationLogger: createNoopLogger(),
			requestJournal,
			transport,
			appRegistry: new TapAppRegistry(dataDir),
		},
		{
			ownerLabel: "tap:typed-events-test",
			...(options?.schedulingHandler ? { schedulingHandler: options.schedulingHandler } : {}),
			hooks: {
				onTypedEvent: (event) => {
					events.push(event);
				},
				...(options?.approveTransfer ? { approveTransfer: options.approveTransfer } : {}),
				...(options?.executeTransfer ? { executeTransfer: options.executeTransfer } : {}),
			},
		},
	);
	return { service, transport, events, requestJournal, dataDir, trustStore };
}

describe("TapMessagingService typed events", () => {
	it("emits message.sent on outbound sendMessage", async () => {
		const active = makeActiveContact("conn-sent");
		const { service, events } = await buildService({ initialContacts: [active] });

		await service.sendMessage(active.peerDisplayName, "hello typed");

		const sent = events.find((e) => e.type === "message.sent");
		expect(sent).toBeDefined();
		if (sent?.type === "message.sent") {
			expect(sent.text).toBe("hello typed");
			expect(sent.peer.peerAgentId).toBe(PEER_AGENT.agentId);
			expect(sent.peer.connectionId).toBe("conn-sent");
			expect(sent.identityAgentId).toBe(1);
			expect(sent.conversationId).toBeTruthy();
		}
		await service.stop();
	});

	it("emits message.received on inbound message", async () => {
		const active = makeActiveContact("conn-recv");
		const { service, transport, events } = await buildService({ initialContacts: [active] });
		await service.start();

		const message: ProtocolMessage = {
			jsonrpc: "2.0",
			id: "msg-1",
			method: "message/send",
			params: {
				message: {
					parts: [{ kind: "text", text: "hi there" }],
					metadata: { trustedAgent: { scope: "general-chat" } },
				},
			},
		} as unknown as ProtocolMessage;

		await transport.handlers.onRequest?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "peer-inbox-msg-recv",
			message,
		});

		const received = events.find((e) => e.type === "message.received");
		expect(received).toBeDefined();
		if (received?.type === "message.received") {
			expect(received.text).toBe("hi there");
			expect(received.peer.peerAgentId).toBe(PEER_AGENT.agentId);
			expect(received.scope).toBe("general-chat");
			expect(received.identityAgentId).toBe(1);
		}
		await service.stop();
	});

	it("emits action.requested kind=grant on outbound sendActionRequest", async () => {
		const active = makeActiveContact("conn-req-action");
		const { service, events } = await buildService({ initialContacts: [active] });

		await service.sendActionRequest(
			{ connectionId: active.connectionId },
			"permissions/request-grants",
			{ actionId: "act-1", grants: [] },
			"asking for grants",
		);

		const requested = events.find(
			(e) => e.type === "action.requested" && e.direction === "outbound",
		);
		expect(requested).toBeDefined();
		if (requested?.type === "action.requested") {
			expect(requested.kind).toBe("grant");
			expect(requested.direction).toBe("outbound");
			expect(requested.peer.peerAgentId).toBe(PEER_AGENT.agentId);
		}
		await service.stop();
	});

	it("emits action.requested kind=scheduling on inbound scheduling request", async () => {
		const active = makeActiveContact("conn-req-sched-inbound");
		const { service, transport, events } = await buildService({ initialContacts: [active] });
		await service.start();

		const schedulingPayload = {
			type: "scheduling/propose",
			schedulingId: "sch-1",
			title: "Demo",
			duration: 30,
			slots: [{ start: "2026-04-20T10:00:00Z", end: "2026-04-20T10:30:00Z" }],
			originTimezone: "UTC",
		};
		const message = buildOutgoingActionRequest(
			active,
			"scheduling request",
			schedulingPayload,
			"scheduling/request",
		);
		await transport.handlers.onRequest?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "peer-inbox-sched-in",
			message,
		});
		await sleep(30);

		const requested = events.find(
			(e) => e.type === "action.requested" && e.direction === "inbound",
		);
		expect(requested).toBeDefined();
		if (requested?.type === "action.requested") {
			expect(requested.kind).toBe("scheduling");
			expect(requested.direction).toBe("inbound");
		}
		await service.stop();
	});

	it("emits action.pending when a transfer is parked awaiting operator approval", async () => {
		const active = makeActiveContact("conn-pending-xfer");
		const approveTransfer = vi.fn(async () => null);
		const { service, transport, events } = await buildService({
			initialContacts: [active],
			approveTransfer,
		});
		await service.start();

		const payload = {
			type: "transfer/request" as const,
			actionId: "act-pending-1",
			asset: "usdc" as const,
			amount: "5",
			chain: PEER_AGENT.chain,
			toAddress: BOB.address,
			note: "pending test",
		};
		const message = buildOutgoingActionRequest(
			active,
			"transfer request",
			payload,
			"transfer/request",
		);
		await transport.handlers.onRequest?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "peer-inbox-pending-xfer",
			message,
		});
		await sleep(50);

		const pending = events.find((e) => e.type === "action.pending");
		expect(pending).toBeDefined();
		if (pending?.type === "action.pending") {
			expect(pending.kind).toBe("transfer");
			expect(pending.awaitingDecision).toBe(true);
		}
		await service.stop();
	});

	it("emits pending.resolved on resolvePending() approval", async () => {
		const active = makeActiveContact("conn-pending-resolve");
		const approveTransfer = vi.fn(async () => null);
		const executeTransfer = vi.fn(async () => ({ txHash: "0xabc" as const }));
		const { service, transport, events } = await buildService({
			initialContacts: [active],
			approveTransfer,
			executeTransfer,
		});
		await service.start();

		const payload = {
			type: "transfer/request" as const,
			actionId: "act-resolve-1",
			asset: "usdc" as const,
			amount: "5",
			chain: PEER_AGENT.chain,
			toAddress: BOB.address,
		};
		const message = buildOutgoingActionRequest(
			active,
			"transfer request",
			payload,
			"transfer/request",
		);
		await transport.handlers.onRequest?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "peer-inbox-resolve-xfer",
			message,
		});
		await sleep(30);

		await service.resolvePending(String(message.id), true);

		const resolved = events.find((e) => e.type === "pending.resolved");
		expect(resolved).toBeDefined();
		if (resolved?.type === "pending.resolved") {
			expect(resolved.decision).toBe("approved");
			expect(resolved.decidedBy).toBe("operator");
		}
		await service.stop();
	});

	it("emits connection.established on accepted inbound connection/result", async () => {
		const connecting = makeConnectingContact("conn-established");
		const { service, transport, events, requestJournal } = await buildService({
			initialContacts: [connecting],
		});
		await service.start();

		// Seed a matching outbound journal entry so the security gate is satisfied.
		await requestJournal.putOutbound({
			requestId: "req-established",
			requestKey: "outbound:connection/request:req-established",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: PEER_AGENT.agentId,
			status: "pending",
			metadata: { peerChain: PEER_AGENT.chain },
		});

		const acceptedResult = buildConnectionResult({
			requestId: "req-established",
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await transport.handlers.onResult?.({
			from: PEER_AGENT.agentId,
			senderInboxId: "peer-inbox-established",
			message: acceptedResult,
		});

		const established = events.find((e) => e.type === "connection.established");
		expect(established).toBeDefined();
		if (established?.type === "connection.established") {
			expect(established.connectionId).toBe(connecting.connectionId);
			expect(established.peer.peerAgentId).toBe(PEER_AGENT.agentId);
		}
		await service.stop();
	});
});
