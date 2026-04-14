import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConversationLogger } from "trusted-agents-core";
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
		sendMessage: vi.fn(async (peer: string, _text: string, scope?: string) => ({
			receipt: { messageId: "msg-1", status: "delivered" },
			peerName: peer,
			peerAgentId: 99,
			scope: scope ?? "general-chat",
		})),
		connect: vi.fn(async (params: { inviteUrl: string; waitMs?: number }) => ({
			connectionId: "conn-1",
			peerName: "Alice",
			peerAgentId: 99,
			status: params.waitMs === 0 ? "pending" : "active",
			receipt: { messageId: "msg-1", status: "delivered" },
		})),
		requestFunds: vi.fn(async (input: { peer: string; asset: string; amount: string }) => ({
			receipt: { messageId: "msg-1", status: "delivered" },
			actionId: "act-1",
			peerName: input.peer,
			peerAgentId: 99,
			asset: input.asset,
			amount: input.amount,
			chain: "eip155:8453",
			toAddress: "0x0000000000000000000000000000000000000000",
		})),
	};
}

const fakeExecuteTransfer = vi.fn(async () => ({
	txHash: "0xabc" as `0x${string}`,
}));

describe("tapd HTTP end-to-end", () => {
	let dataDir: string;
	let daemon: Daemon | null = null;
	let port = 0;
	let token = "";
	let service: ReturnType<typeof makeFakeService>;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-e2e-"));
		service = makeFakeService();
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
			executeTransfer: fakeExecuteTransfer,
		});
		fakeExecuteTransfer.mockClear();
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

	it("POST /daemon/sync returns ok with the sync report", async () => {
		const response = await fetchTapd("/daemon/sync", { method: "POST" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; report?: Record<string, unknown> };
		expect(body.ok).toBe(true);
		expect(body.report).toBeDefined();
	});

	it("rejects requests without a bearer token", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/api/identity`);
		expect(response.status).toBe(401);
	});

	it("returns 404 for unknown routes", async () => {
		const response = await fetchTapd("/api/nope");
		expect(response.status).toBe(404);
	});

	it("POST /api/funds-requests forwards to the service and returns the result", async () => {
		const response = await fetchTapd("/api/funds-requests", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				peer: "Alice",
				asset: "usdc",
				amount: "1.50",
				chain: "eip155:8453",
				toAddress: "0x0000000000000000000000000000000000000000",
				note: "lunch",
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { actionId: string; peerName: string };
		expect(body.actionId).toBe("act-1");
		expect(body.peerName).toBe("Alice");
		expect(service.requestFunds).toHaveBeenCalledOnce();
	});

	it("POST /api/transfers calls the executor and returns txHash", async () => {
		const response = await fetchTapd("/api/transfers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				asset: "usdc",
				amount: "1.50",
				chain: "eip155:8453",
				toAddress: "0x0000000000000000000000000000000000000000",
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ txHash: "0xabc" });
		expect(fakeExecuteTransfer).toHaveBeenCalledOnce();
	});

	it("POST /api/connect forwards to the service and returns the result", async () => {
		const response = await fetchTapd("/api/connect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ inviteUrl: "tap://invite/abc", waitMs: 1000 }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string; peerAgentId: number };
		expect(body.status).toBe("active");
		expect(body.peerAgentId).toBe(99);
		expect(service.connect).toHaveBeenCalledOnce();
	});

	it("POST /api/messages forwards to the service and returns the result", async () => {
		const response = await fetchTapd("/api/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ peer: "Alice", text: "hello", scope: "general-chat" }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { peerName: string; scope: string };
		expect(body.peerName).toBe("Alice");
		expect(body.scope).toBe("general-chat");
		expect(service.sendMessage).toHaveBeenCalledOnce();
		expect(service.sendMessage.mock.calls[0]?.slice(0, 3)).toEqual([
			"Alice",
			"hello",
			"general-chat",
		]);
	});
});

describe("tapd HTTP + SqliteConversationLogger", () => {
	let dataDir: string;
	let daemon: Daemon | null = null;
	let port = 0;
	let token = "";
	let conversationLogger: SqliteConversationLogger;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-sqlite-e2e-"));
		conversationLogger = new SqliteConversationLogger(dataDir);
		const service = makeFakeService();
		daemon = new Daemon({
			config: {
				dataDir,
				socketPath: join(dataDir, ".tapd.sock"),
				tcpHost: "127.0.0.1",
				tcpPort: 0,
				ringBufferSize: 100,
			},
			identityAgentId: 1,
			identitySource: () => ({
				agentId: 1,
				chain: "eip155:8453",
				address: "0xabc",
				displayName: "Self",
				dataDir,
			}),
			buildService: async () => service as never,
			trustStore: { getContacts: async () => [], getContact: async () => null } as never,
			conversationLogger,
			executeTransfer: fakeExecuteTransfer,
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
		conversationLogger.close();
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

	it("persists conversations to SQLite and returns them via GET /api/conversations", async () => {
		await conversationLogger.logMessage(
			"conv-sql",
			{
				timestamp: "2026-04-01T00:00:00.000Z",
				direction: "outgoing",
				scope: "general-chat",
				content: "hello sqlite",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{
				connectionId: "conn-1",
				peerAgentId: 2,
				peerDisplayName: "Bob",
			},
		);

		const response = await fetchTapd("/api/conversations");
		expect(response.status).toBe(200);
		const body = (await response.json()) as Array<{
			conversationId: string;
			peerDisplayName: string;
			messages: { content: string }[];
		}>;
		expect(body).toHaveLength(1);
		expect(body[0]?.conversationId).toBe("conv-sql");
		expect(body[0]?.peerDisplayName).toBe("Bob");
		expect(body[0]?.messages[0]?.content).toBe("hello sqlite");
	});

	it("GET /api/conversations/:id returns a single conversation from SQLite", async () => {
		await conversationLogger.logMessage(
			"conv-show",
			{
				timestamp: "2026-04-01T00:00:00.000Z",
				direction: "incoming",
				scope: "default",
				content: "incoming sqlite",
				humanApprovalRequired: false,
				humanApprovalGiven: null,
			},
			{
				connectionId: "conn-2",
				peerAgentId: 3,
				peerDisplayName: "Carol",
			},
		);

		const response = await fetchTapd("/api/conversations/conv-show");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			conversationId: string;
			peerDisplayName: string;
			messages: { content: string }[];
		} | null;
		expect(body?.conversationId).toBe("conv-show");
		expect(body?.peerDisplayName).toBe("Carol");
		expect(body?.messages[0]?.content).toBe("incoming sqlite");
	});
});
