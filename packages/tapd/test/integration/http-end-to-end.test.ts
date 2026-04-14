import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon.js";

function makeFakeService() {
	return {
		hooks: {} as { emitEvent?: (payload: Record<string, unknown>) => void },
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		getStatus: vi.fn(async () => ({ running: true, lock: null, pendingRequests: [] })),
		resolvePending: vi.fn(async () => ({})),
		syncOnce: vi.fn(async () => ({
			synced: true,
			processed: 0,
			pendingRequests: [],
			pendingDeliveries: [],
		})),
	};
}

describe("tapd HTTP end-to-end", () => {
	let dataDir: string;
	let daemon: Daemon | null = null;
	let port = 0;
	let token = "";

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-e2e-"));
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
		port = daemon.boundTcpPort();
		token = daemon.authToken();
	});

	afterEach(async () => {
		if (daemon) {
			await daemon.stop().catch(() => {});
			daemon = null;
		}
		await rm(dataDir, { recursive: true, force: true });
	});

	const fetchTapd = (path: string, init?: RequestInit) =>
		fetch(`http://127.0.0.1:${port}${path}`, {
			...init,
			headers: {
				...(init?.headers ?? {}),
				Authorization: `Bearer ${token}`,
			},
		});

	it("GET /api/identity returns the identity", async () => {
		const response = await fetchTapd("/api/identity");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ agentId: 42, displayName: "Alice" });
	});

	it("GET /api/contacts returns an empty list initially", async () => {
		const response = await fetchTapd("/api/contacts");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});

	it("GET /api/conversations returns an empty list initially", async () => {
		const response = await fetchTapd("/api/conversations");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});

	it("GET /api/pending returns an empty list initially", async () => {
		const response = await fetchTapd("/api/pending");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});

	it("GET /api/notifications/drain returns an empty list initially", async () => {
		const response = await fetchTapd("/api/notifications/drain");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ notifications: [] });
	});

	it("GET /daemon/health returns ok", async () => {
		const response = await fetchTapd("/daemon/health");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string; transportConnected: boolean };
		expect(body.status).toBe("ok");
		expect(body.transportConnected).toBe(true);
	});

	it("POST /daemon/sync returns ok", async () => {
		const response = await fetchTapd("/daemon/sync", { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("rejects requests without a bearer token", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/api/identity`);
		expect(response.status).toBe(401);
	});

	it("returns 404 for unknown routes", async () => {
		const response = await fetchTapd("/api/nope");
		expect(response.status).toBe(404);
	});
});
