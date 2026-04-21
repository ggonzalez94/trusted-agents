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

async function readSseEvents(
	url: string,
	headers: Record<string, string>,
	maxMs: number,
): Promise<TapEvent[]> {
	const controller = new AbortController();
	const response = await fetch(url, { headers, signal: controller.signal });
	if (!response.body) return [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events: TapEvent[] = [];
	let buffer = "";
	const deadline = Date.now() + maxMs;

	try {
		while (Date.now() < deadline) {
			const raceResult = await Promise.race([
				reader.read(),
				new Promise<{ value: undefined; done: true }>((resolve) =>
					setTimeout(() => resolve({ value: undefined, done: true }), 100),
				),
			]);
			if (raceResult.done) break;
			if (!raceResult.value) continue;
			buffer += decoder.decode(raceResult.value, { stream: true });
			while (buffer.includes("\n\n")) {
				const idx = buffer.indexOf("\n\n");
				const block = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
				if (dataLine) {
					try {
						events.push(JSON.parse(dataLine.slice("data: ".length)) as TapEvent);
					} catch {
						/* ignore non-JSON */
					}
				}
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			/* ignore */
		}
		reader.releaseLock();
		controller.abort();
	}
	return events;
}

describe("tapd SSE replay", () => {
	let dataDir: string;
	let daemon: Daemon | null = null;
	let port = 0;
	let token = "";
	let service: FakeService;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-sse-"));
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

	it("delivers events emitted via the underlying service hook", async () => {
		// Emit two typed events through the service hook BEFORE the SSE client
		// connects. New clients (no Last-Event-ID) start fresh, so the client
		// must reconnect with the id of the last seen event to get replay.
		service.hooks.onTypedEvent?.({
			id: "evt-1",
			occurredAt: "2026-04-13T00:00:00.000Z",
			identityAgentId: 1,
			type: "message.received",
			conversationId: "conv-1",
			peer: {
				connectionId: "conn-1",
				peerAgentId: 99,
				peerName: "Bob",
				peerChain: "eip155:8453",
			},
			messageId: "wire-1",
			text: "hello",
			scope: "general-chat",
		});
		service.hooks.onTypedEvent?.({
			id: "evt-2",
			occurredAt: "2026-04-13T00:00:00.000Z",
			identityAgentId: 1,
			type: "message.received",
			conversationId: "conv-1",
			peer: {
				connectionId: "conn-1",
				peerAgentId: 99,
				peerName: "Bob",
				peerChain: "eip155:8453",
			},
			messageId: "wire-2",
			text: "world",
			scope: "general-chat",
		});

		// Connect the SSE client with a non-existent Last-Event-ID — semantics
		// say "client missed everything in the buffer," so all 2 should replay.
		const events = await readSseEvents(
			`http://127.0.0.1:${port}/api/events/stream`,
			{ Authorization: `Bearer ${token}`, "Last-Event-ID": "evt-unknown" },
			500,
		);

		expect(events.length).toBeGreaterThanOrEqual(2);
		const messageEvents = events.filter((e) => e.type === "message.received");
		expect(messageEvents.length).toBe(2);
		expect((messageEvents[0] as { text: string }).text).toBe("hello");
		expect((messageEvents[1] as { text: string }).text).toBe("world");
	});

	it("replays only events strictly after the given Last-Event-ID", async () => {
		service.hooks.onTypedEvent?.({
			id: "evt-a",
			occurredAt: "2026-04-13T00:00:00.000Z",
			identityAgentId: 1,
			type: "message.received",
			conversationId: "conv-1",
			peer: {
				connectionId: "conn-1",
				peerAgentId: 99,
				peerName: "Bob",
				peerChain: "eip155:8453",
			},
			messageId: "wire-1",
			text: "first",
			scope: "general-chat",
		});
		service.hooks.onTypedEvent?.({
			id: "evt-b",
			occurredAt: "2026-04-13T00:00:00.000Z",
			identityAgentId: 1,
			type: "message.received",
			conversationId: "conv-1",
			peer: {
				connectionId: "conn-1",
				peerAgentId: 99,
				peerName: "Bob",
				peerChain: "eip155:8453",
			},
			messageId: "wire-2",
			text: "second",
			scope: "general-chat",
		});

		// Inspect the bus directly to find the actual generated event id of the first event.
		const firstClientEvents = await readSseEvents(
			`http://127.0.0.1:${port}/api/events/stream`,
			{ Authorization: `Bearer ${token}`, "Last-Event-ID": "evt-unknown" },
			500,
		);
		expect(firstClientEvents.length).toBeGreaterThanOrEqual(2);
		const firstEventId = firstClientEvents[0].id;

		// New connection asking for events strictly after the first — should get only the second.
		const replayed = await readSseEvents(
			`http://127.0.0.1:${port}/api/events/stream`,
			{ Authorization: `Bearer ${token}`, "Last-Event-ID": firstEventId },
			500,
		);
		const messages = replayed.filter((e) => e.type === "message.received");
		expect(messages.length).toBe(1);
		expect((messages[0] as { text: string }).text).toBe("second");
	});
});
