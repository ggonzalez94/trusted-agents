import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("legacy state migration — outbox directory", () => {
	function seedOutboxFile(
		dir: string,
		subdir: "queued" | "processing" | "results",
		jobId: string,
		job: Record<string, unknown>,
	): void {
		const target = join(dir, "outbox", subdir);
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, `${jobId}.json`), JSON.stringify(job));
	}

	it("migrates queued and processing files into journal as queued entries", async () => {
		const dir = makeTempDir();

		seedOutboxFile(dir, "queued", "job-q-1", {
			jobId: "job-q-1",
			type: "send-message",
			createdAt: "2026-04-09T00:00:00Z",
			requestedBy: "tap:cli",
			payload: { peer: "alice", text: "hello", scope: "general-chat" },
		});
		seedOutboxFile(dir, "processing", "job-p-1", {
			jobId: "job-p-1",
			type: "connect",
			createdAt: "2026-04-09T00:01:00Z",
			claimedAt: "2026-04-09T00:01:05Z",
			claimedBy: "tap:old-process",
			claimedByPid: 99999,
			payload: { inviteUrl: "https://example.com/invite" },
		});
		seedOutboxFile(dir, "results", "job-r-1", {
			jobId: "job-r-1",
			type: "send-message",
			finishedAt: "2026-04-09T00:00:10Z",
			status: "completed",
		});

		const { service } = makeServiceHarness(dir);
		await service.start();
		await service.stop();

		// Two command journal entries were migrated: one from queued/, one from processing/.
		// The service processes them immediately on start, so status may be "completed".
		const journal = new FileRequestJournal(dir);
		const all = await journal.list("outbound");
		const commandEntries = all.filter((e) => e.method.startsWith("command/"));
		expect(commandEntries).toHaveLength(2);

		const methods = commandEntries.map((e) => e.method).sort();
		expect(methods).toEqual(["command/connect", "command/send-message"]);

		// Each entry carries the right commandType and payload.
		const sendEntry = commandEntries.find((e) => e.method === "command/send-message")!;
		expect((sendEntry.metadata as Record<string, unknown>)?.commandType).toBe("send-message");
		// commandPayload is preserved either directly or inside the claim+result metadata
		const payload = (sendEntry.metadata as Record<string, unknown>)?.commandPayload as Record<
			string,
			unknown
		>;
		expect(payload?.peer).toBe("alice");
		expect(payload?.text).toBe("hello");
		expect(payload?.scope).toBe("general-chat");

		// Legacy outbox directory is deleted.
		expect(existsSync(join(dir, "outbox"))).toBe(false);
	});

	it("is idempotent — running start twice does not double-migrate", async () => {
		const dir = makeTempDir();

		seedOutboxFile(dir, "queued", "job-q-dup", {
			jobId: "job-q-dup",
			type: "send-message",
			createdAt: "2026-04-09T00:00:00Z",
			payload: { peer: "bob", text: "hi", scope: "general-chat" },
		});

		// First start: migrates and deletes the file.
		const h1 = makeServiceHarness(dir);
		await h1.service.start();
		await h1.service.stop();

		// Second start: no outbox directory; migration is a no-op.
		const h2 = makeServiceHarness(dir);
		await h2.service.start();
		await h2.service.stop();

		const journal = new FileRequestJournal(dir);
		const all = await journal.list("outbound");
		const commandEntries = all.filter((e) => e.method.startsWith("command/"));
		// Still exactly one entry, not two.
		expect(commandEntries).toHaveLength(1);
	});

	it("is a no-op when outbox directory does not exist", async () => {
		const dir = makeTempDir();
		const { service } = makeServiceHarness(dir);
		await expect(service.start()).resolves.toBeUndefined();
		await service.stop();
		expect(existsSync(join(dir, "outbox"))).toBe(false);
	});

	it("discards results-only outbox (no queued/processing entries)", async () => {
		const dir = makeTempDir();

		seedOutboxFile(dir, "results", "job-done", {
			jobId: "job-done",
			status: "completed",
		});

		const { service } = makeServiceHarness(dir);
		await service.start();
		await service.stop();

		// No journal command entries from results (results-only means nothing to migrate).
		const journal = new FileRequestJournal(dir);
		const all = await journal.list("outbound");
		const commandEntries = all.filter((e) => e.method.startsWith("command/"));
		expect(commandEntries).toHaveLength(0);
		expect(existsSync(join(dir, "outbox"))).toBe(false);
	});
});
