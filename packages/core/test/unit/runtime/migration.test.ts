import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { FileRequestJournal } from "../../../src/runtime/request-journal.js";
import { TapMessagingService } from "../../../src/runtime/service.js";
import type {
	ProtocolMessage,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "../../../src/transport/interface.js";
import type { TransportSendOptions } from "../../../src/transport/types.js";
import { FileTrustStore } from "../../../src/trust/file-trust-store.js";
import { ALICE, ALICE_SIGNING_PROVIDER, BOB } from "../../fixtures/test-keys.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async (dir) => {
			await rm(dir, { recursive: true, force: true });
		}),
	);
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tap-migration-"));
	tempDirs.push(dir);
	return dir;
}

class FakeTransport implements TransportProvider {
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
		_peerId: number,
		message: ProtocolMessage,
		_options?: TransportSendOptions,
	): Promise<TransportReceipt> {
		return {
			received: true,
			requestId: String(message.id),
			status: "received",
			receivedAt: new Date().toISOString(),
		};
	}
}

const STATIC_PEER: ResolvedAgent = {
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
	resolvedAt: new Date().toISOString(),
};

function createStaticResolver(agent: ResolvedAgent = STATIC_PEER): IAgentResolver {
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

function makeServiceHarness(dataDir: string): {
	service: TapMessagingService;
	trustStore: FileTrustStore;
} {
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

	const trustStore = new FileTrustStore(dataDir);
	const requestJournal = new FileRequestJournal(dataDir);
	const transport = new FakeTransport();
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
		{
			ownerLabel: "tap:migration-test",
		},
	);

	return { service, trustStore };
}

const SAMPLE_LEGACY_ENTRY = {
	requestId: "req-1",
	peerAgentId: 42,
	peerChain: "eip155:8453",
	peerOwnerAddress: ALICE.address,
	peerDisplayName: "alice",
	peerAgentAddress: ALICE.address,
	createdAt: "2026-04-09T00:00:00Z",
};

describe("legacy state migration — pending-connects.json", () => {
	it("migrates pending-connects.json entries into connecting contacts", async () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "pending-connects.json"),
			JSON.stringify({ pendingConnects: [SAMPLE_LEGACY_ENTRY] }),
		);

		const { service, trustStore } = makeServiceHarness(dir);
		await service.start();
		await service.stop();

		const contact = await trustStore.findByAgentId(42, "eip155:8453");
		expect(contact).not.toBeNull();
		expect(contact?.status).toBe("connecting");
		expect(contact?.peerDisplayName).toBe("alice");
		expect(existsSync(join(dir, "pending-connects.json"))).toBe(false);
	});

	it("is idempotent — running start twice produces one contact, not two", async () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "pending-connects.json"),
			JSON.stringify({ pendingConnects: [SAMPLE_LEGACY_ENTRY] }),
		);

		// First start: migrates and deletes the file.
		const h1 = makeServiceHarness(dir);
		await h1.service.start();
		await h1.service.stop();

		// File is deleted; starting again should be a no-op for migration.
		const h2 = makeServiceHarness(dir);
		await h2.service.start();
		await h2.service.stop();

		const contacts = await h2.trustStore.getContacts();
		const matches = contacts.filter((c) => c.peerAgentId === 42 && c.peerChain === "eip155:8453");
		expect(matches).toHaveLength(1);
	});

	it("is a no-op when pending-connects.json does not exist", async () => {
		const dir = makeTempDir();
		const { service } = makeServiceHarness(dir);
		await expect(service.start()).resolves.toBeUndefined();
		await service.stop();
	});

	it("tolerates malformed JSON (logs warning, does not throw)", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "pending-connects.json"), "not valid json{");
		const { service } = makeServiceHarness(dir);
		await expect(service.start()).resolves.toBeUndefined();
		await service.stop();
	});
});

describe("legacy state migration — acked status rewrite", () => {
	it("rewrites legacy acked entries to pending on start", async () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "request-journal.json"),
			JSON.stringify({
				entries: [
					{
						requestId: "req-legacy",
						requestKey: "outbound:req-legacy",
						direction: "outbound",
						kind: "request",
						method: "message/send",
						peerAgentId: 42,
						status: "acked",
						createdAt: "2026-04-09T00:00:00Z",
						updatedAt: "2026-04-09T00:00:00Z",
					},
				],
			}),
		);

		const { service } = makeServiceHarness(dir);
		await service.start();
		await service.stop();

		// Re-read the file directly via a fresh journal instance
		const journal = new FileRequestJournal(dir);
		const entry = await journal.getByRequestId("req-legacy");
		expect(entry?.status).toBe("pending");
	});

	it("is idempotent — a second start does not re-migrate", async () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "request-journal.json"),
			JSON.stringify({
				entries: [
					{
						requestId: "req-legacy-2",
						requestKey: "outbound:req-legacy-2",
						direction: "outbound",
						kind: "request",
						method: "message/send",
						peerAgentId: 42,
						status: "acked",
						createdAt: "2026-04-09T00:00:00Z",
						updatedAt: "2026-04-09T00:00:00Z",
					},
				],
			}),
		);

		// First start: migrates the entry.
		const h1 = makeServiceHarness(dir);
		await h1.service.start();
		await h1.service.stop();

		// Second start: no errors, status still pending.
		const h2 = makeServiceHarness(dir);
		await expect(h2.service.start()).resolves.toBeUndefined();
		await h2.service.stop();

		const journal = new FileRequestJournal(dir);
		const entry = await journal.getByRequestId("req-legacy-2");
		expect(entry?.status).toBe("pending");
	});
});
