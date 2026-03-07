import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { FileRequestJournal } from "../../../src/runtime/request-journal.js";
import { FileRequestJournal as FileRequestJournalImpl } from "../../../src/runtime/request-journal.js";
import { TapMessagingService } from "../../../src/runtime/service.js";
import type {
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "../../../src/transport/interface.js";
import type { ITrustStore } from "../../../src/trust/trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import { ALICE } from "../../fixtures/test-keys.js";

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
		} = {},
	) {}

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

	async send(): Promise<TransportReceipt> {
		return {
			received: true,
			requestId: "req-1",
			status: "received",
			receivedAt: "2026-03-07T00:00:00.000Z",
		};
	}
}

function createNoopTrustStore(): ITrustStore {
	return {
		getContacts: async () => [],
		getContact: async (_connectionId: string) => null,
		findByAgentAddress: async (_address: `0x${string}`, _chain?: string) => null,
		findByAgentId: async (_agentId: number, _chain: string) => null,
		addContact: async (_contact: Contact) => {},
		updateContact: async (_connectionId: string, _updates: Partial<Contact>) => {},
		removeContact: async (_connectionId: string) => {},
		touchContact: async (_connectionId: string) => {},
	};
}

function createNoopResolver(): IAgentResolver {
	return {
		resolve: async (_agentId: number, _chain: string) => {
			throw new Error("resolver should not be used in this test");
		},
		resolveWithCache: async (_agentId: number, _chain: string, _maxAgeMs?: number) => {
			throw new Error("resolver should not be used in this test");
		},
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
	const transport = new FakeTransport(options);
	const service = new TapMessagingService(
		{
			config,
			trustStore: createNoopTrustStore(),
			resolver: createNoopResolver(),
			conversationLogger: createNoopConversationLogger(),
			requestJournal,
			transport,
		},
		{ ownerLabel: "tap:test-service" },
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
});
