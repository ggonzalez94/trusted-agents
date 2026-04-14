import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TapEvent } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon.js";

interface FakeService {
	hooks: {
		emitEvent?: (payload: Record<string, unknown>) => void;
		onTypedEvent?: (event: TapEvent) => void;
	};
	start: () => Promise<void>;
	stop: () => Promise<void>;
	getStatus: () => Promise<{ running: boolean; lock: null; pendingRequests: never[] }>;
	resolvePending: (id: string, approve: boolean, reason?: string) => Promise<unknown>;
	syncOnce: () => Promise<unknown>;
}

function makeFakeService(): FakeService {
	return {
		hooks: {},
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		getStatus: async () => ({ running: true, lock: null, pendingRequests: [] }),
		resolvePending: vi.fn(async () => ({})),
		syncOnce: vi.fn(async () => ({
			synced: true,
			processed: 0,
			pendingRequests: [],
			pendingDeliveries: [],
		})),
	};
}

describe("Daemon lifecycle", () => {
	let dataDir: string;
	let daemon: Daemon | null = null;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-lifecycle-"));
	});

	afterEach(async () => {
		if (daemon) {
			await daemon.stop().catch(() => {});
			daemon = null;
		}
		await rm(dataDir, { recursive: true, force: true });
	});

	it("starts and stops cleanly", async () => {
		const service = makeFakeService();
		daemon = new Daemon({
			config: {
				dataDir,
				socketPath: join(dataDir, ".tapd.sock"),
				tcpHost: "127.0.0.1",
				tcpPort: 0,
				ringBufferSize: 100,
			},
			identityAgentId: 42,
			identitySource: () => ({
				agentId: 42,
				chain: "eip155:8453",
				address: "0xabc",
				displayName: "Alice",
				dataDir,
			}),
			buildService: async () => service as never,
			trustStore: { getContacts: async () => [], getContact: async () => null } as never,
			conversationLogger: {
				logMessage: async () => {},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			} as never,
		});

		await daemon.start();
		expect(service.start).toHaveBeenCalledTimes(1);

		const port = daemon.boundTcpPort();
		const token = daemon.authToken();
		const response = await fetch(`http://127.0.0.1:${port}/api/identity`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ agentId: 42, displayName: "Alice" });

		// The daemon publishes its bound TCP port so clients can discover us.
		const portFile = join(dataDir, ".tapd.port");
		const portContents = await readFile(portFile, "utf-8");
		expect(Number.parseInt(portContents, 10)).toBe(port);

		await daemon.stop();
		expect(service.stop).toHaveBeenCalledTimes(1);

		// The port file is removed on shutdown so a stale value never points to
		// a dead daemon.
		await expect(stat(portFile)).rejects.toThrow();
	});

	it("serves /daemon/health over the socket", async () => {
		const service = makeFakeService();
		daemon = new Daemon({
			config: {
				dataDir,
				socketPath: join(dataDir, ".tapd.sock"),
				tcpHost: "127.0.0.1",
				tcpPort: 0,
				ringBufferSize: 100,
			},
			identityAgentId: 42,
			identitySource: () => ({
				agentId: 42,
				chain: "eip155:8453",
				address: "0xabc",
				displayName: "Alice",
				dataDir,
			}),
			buildService: async () => service as never,
			trustStore: { getContacts: async () => [], getContact: async () => null } as never,
			conversationLogger: {
				logMessage: async () => {},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			} as never,
		});

		await daemon.start();
		const port = daemon.boundTcpPort();
		const token = daemon.authToken();
		const response = await fetch(`http://127.0.0.1:${port}/daemon/health`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string; version: string };
		expect(body.status).toBe("ok");
	});

	// Finding F1.1: a failed HTTP bind must not strand the runtime. Before
	// the fix, runtime.start() held the transport owner lock but a bind
	// failure meant there was no reachable control plane and every retry hit
	// the lock.
	it("unwinds runtime when the HTTP server fails to bind", async () => {
		// Pre-bind a TCP socket on localhost to force our daemon's bindTcp()
		// to fail with EADDRINUSE.
		const blocker = createHttpServer();
		const blockerPort = await new Promise<number>((resolve) => {
			blocker.listen(0, "127.0.0.1", () => {
				const addr = blocker.address();
				if (addr && typeof addr === "object") resolve(addr.port);
			});
		});

		const service = makeFakeService();
		const failingDaemon = new Daemon({
			config: {
				dataDir,
				socketPath: join(dataDir, ".tapd.sock"),
				tcpHost: "127.0.0.1",
				tcpPort: blockerPort,
				ringBufferSize: 100,
			},
			identityAgentId: 42,
			identitySource: () => ({
				agentId: 42,
				chain: "eip155:8453",
				address: "0xabc",
				displayName: "Alice",
				dataDir,
			}),
			buildService: async () => service as never,
			trustStore: { getContacts: async () => [], getContact: async () => null } as never,
			conversationLogger: {
				logMessage: async () => {},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			} as never,
		});

		const bus = failingDaemon.eventBus();
		const subscribersBefore = bus.subscriberCount();

		await expect(failingDaemon.start()).rejects.toThrow();

		// Runtime MUST have been stopped — the transport owner lock would
		// otherwise remain held and block every retry.
		expect(service.start).toHaveBeenCalledTimes(1);
		expect(service.stop).toHaveBeenCalledTimes(1);

		// Bus subscription installed by start() must have been released so
		// we don't leak handlers across restart attempts.
		expect(bus.subscriberCount()).toBe(subscribersBefore);

		// No port file on disk — the daemon never bound, so publishing one
		// would advertise a dead control plane.
		await expect(stat(join(dataDir, ".tapd.port"))).rejects.toThrow();

		// Cleanup: release the blocker and the bound-but-failed daemon.
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
		await failingDaemon.stop().catch(() => {});
	});
});
