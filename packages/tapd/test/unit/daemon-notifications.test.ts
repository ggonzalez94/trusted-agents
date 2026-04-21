import { mkdtemp, rm } from "node:fs/promises";
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
		syncOnce: vi.fn(async () => ({})),
	};
}

describe("Daemon → NotificationQueue wiring", () => {
	let dataDir: string;
	let daemon: Daemon | null = null;
	let port = 0;
	let token = "";
	let service: FakeService;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-notif-"));
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

	it("enqueues a notification when action.pending is emitted", async () => {
		service.hooks.onTypedEvent?.({
			id: "evt-pending",
			occurredAt: "2026-04-13T00:00:00.000Z",
			identityAgentId: 42,
			type: "action.pending",
			conversationId: "conv-1",
			requestId: "req-42",
			kind: "transfer",
			payload: {},
			awaitingDecision: true,
		});

		const response = await fetch(`http://127.0.0.1:${port}/api/notifications/drain`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			notifications: Array<{ type: string; oneLiner: string }>;
		};
		expect(body.notifications.length).toBeGreaterThanOrEqual(1);
		const pending = body.notifications.find((n) => n.oneLiner.includes("req-42"));
		expect(pending).toBeDefined();
		expect(pending?.type).toBe("escalation");
	});

	it("drain is idempotent (reading twice returns empty the second time)", async () => {
		service.hooks.onTypedEvent?.({
			id: "evt-msg",
			occurredAt: "2026-04-13T00:00:00.000Z",
			identityAgentId: 42,
			type: "message.received",
			conversationId: "conv-1",
			peer: {
				connectionId: "conn-1",
				peerAgentId: 99,
				peerName: "Bob",
				peerChain: "eip155:8453",
			},
			messageId: "m-1",
			text: "hi",
			scope: "general-chat",
		});

		const first = (await (
			await fetch(`http://127.0.0.1:${port}/api/notifications/drain`, {
				headers: { Authorization: `Bearer ${token}` },
			})
		).json()) as { notifications: unknown[] };
		expect(first.notifications.length).toBe(1);

		const second = (await (
			await fetch(`http://127.0.0.1:${port}/api/notifications/drain`, {
				headers: { Authorization: `Bearer ${token}` },
			})
		).json()) as { notifications: unknown[] };
		expect(second.notifications.length).toBe(0);
	});

	it("does not enqueue a notification for message.sent", async () => {
		service.hooks.onTypedEvent?.({
			id: "evt-sent",
			occurredAt: "2026-04-13T00:00:00.000Z",
			identityAgentId: 42,
			type: "message.sent",
			conversationId: "conv-1",
			peer: {
				connectionId: "conn-1",
				peerAgentId: 99,
				peerName: "Bob",
				peerChain: "eip155:8453",
			},
			messageId: "m-out",
			text: "hello",
			scope: "general-chat",
		});

		const response = (await (
			await fetch(`http://127.0.0.1:${port}/api/notifications/drain`, {
				headers: { Authorization: `Bearer ${token}` },
			})
		).json()) as { notifications: unknown[] };
		expect(response.notifications.length).toBe(0);
	});
});
