import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStream } from "../../lib/events.js";

class FakeEventSource {
	public onopen: (() => void) | null = null;
	public onerror: ((e: unknown) => void) | null = null;
	public onmessage: ((e: MessageEvent) => void) | null = null;
	public readyState = 0;
	public closed = false;
	private listeners = new Map<string, ((e: Event) => void)[]>();

	constructor(public readonly url: string) {
		queueMicrotask(() => {
			this.readyState = 1;
			this.onopen?.();
		});
	}

	addEventListener(type: string, handler: (e: Event) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(handler);
		this.listeners.set(type, list);
	}

	removeEventListener(type: string): void {
		this.listeners.delete(type);
	}

	close(): void {
		this.closed = true;
		this.readyState = 2;
	}

	emit(type: string, payload: unknown, id?: string): void {
		const event = new MessageEvent(type, {
			data: JSON.stringify(payload),
			lastEventId: id ?? "",
		});
		for (const handler of this.listeners.get(type) ?? []) {
			handler(event);
		}
	}

	dispatchError(): void {
		for (const handler of this.listeners.get("error") ?? []) {
			handler(new Event("error"));
		}
	}
}

describe("EventStream", () => {
	let createdSources: FakeEventSource[];

	beforeEach(() => {
		createdSources = [];
		vi.stubGlobal(
			"EventSource",
			vi.fn((url: string) => {
				const source = new FakeEventSource(url);
				createdSources.push(source);
				return source;
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("opens an EventSource against the given URL with token query param", () => {
		const stream = new EventStream("http://localhost:6810", "abc-token", () => {});
		stream.start();
		expect(createdSources[0].url).toContain("/api/events/stream");
		expect(createdSources[0].url).toContain("token=abc-token");
	});

	it("dispatches typed events to the handler", () => {
		const events: unknown[] = [];
		const stream = new EventStream("http://localhost:6810", "abc", (event) => events.push(event));
		stream.start();
		createdSources[0].emit(
			"message.received",
			{
				id: "evt-1",
				type: "message.received",
				occurredAt: "2026-04-01T00:00:00.000Z",
				identityAgentId: 42,
				conversationId: "conv-1",
				peer: {
					connectionId: "c",
					peerAgentId: 99,
					peerName: "Bob",
					peerChain: "eip155:8453",
				},
				messageId: "m-1",
				text: "hello",
				scope: "default",
			},
			"evt-1",
		);

		expect(events).toHaveLength(1);
		expect((events[0] as { type: string }).type).toBe("message.received");
	});

	it("closes the EventSource on stop()", () => {
		const stream = new EventStream("http://localhost:6810", "abc", () => {});
		stream.start();
		stream.stop();
		expect(createdSources[0].closed).toBe(true);
	});

	it("sends lastEventId on reconnect after seeing an event", () => {
		const stream = new EventStream("http://localhost:6810", "abc", () => {});
		stream.start();
		createdSources[0].emit(
			"daemon.status",
			{
				id: "evt-7",
				type: "daemon.status",
				occurredAt: "x",
				identityAgentId: 1,
				transportConnected: true,
			},
			"evt-7",
		);
		stream.reconnect();
		expect(createdSources).toHaveLength(2);
		expect(createdSources[1].url).toContain("lastEventId=evt-7");
	});

	it("does not open a second EventSource if start() is called twice", () => {
		const stream = new EventStream("http://localhost:6810", "abc", () => {});
		stream.start();
		stream.start();
		expect(createdSources).toHaveLength(1);
	});

	// ── Residual 3: SSE error → /api/identity probe → onUnauthorized ──
	// Native EventSource.onerror is a generic event with no HTTP status,
	// so we probe /api/identity with the same token to distinguish a
	// stale token from a transient blip.

	it("probes /api/identity on stream error and calls onUnauthorized when the probe returns 401", async () => {
		const fetchMock = vi.fn(async () => unauthorizedResponse());
		vi.stubGlobal("fetch", fetchMock);
		const onUnauthorized = vi.fn();
		const stream = new EventStream("http://localhost:6810", "stale", () => {}, { onUnauthorized });
		stream.start();
		createdSources[0].dispatchError();
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(call[0]).toBe("http://localhost:6810/api/identity");
		expect((call[1].headers as Record<string, string>).Authorization).toBe("Bearer stale");
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
		// Probe also tore the underlying source down so we don't keep
		// banging on the dead token after the dashboard re-auths.
		expect(createdSources[0].closed).toBe(true);
	});

	it("does not call onUnauthorized when the identity probe returns 200", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onUnauthorized = vi.fn();
		const stream = new EventStream("http://localhost:6810", "good", () => {}, { onUnauthorized });
		stream.start();
		createdSources[0].dispatchError();
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(onUnauthorized).not.toHaveBeenCalled();
		// Source is left open — native EventSource reconnect handles it.
		expect(createdSources[0].closed).toBe(false);
	});

	it("deduplicates probes while one is already in flight", async () => {
		let resolve: (() => void) | undefined;
		const gate = new Promise<Response>((r) => {
			resolve = () =>
				r(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
		});
		const fetchMock = vi.fn(() => gate);
		vi.stubGlobal("fetch", fetchMock);
		const stream = new EventStream("http://localhost:6810", "t", () => {}, {
			onUnauthorized: vi.fn(),
		});
		stream.start();
		createdSources[0].dispatchError();
		createdSources[0].dispatchError();
		createdSources[0].dispatchError();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		resolve?.();
		await flush();
	});
});

function unauthorizedResponse(): Response {
	return new Response(JSON.stringify({ error: { code: "unauthorized", message: "stale" } }), {
		status: 401,
		headers: { "content-type": "application/json" },
	});
}

async function flush(): Promise<void> {
	// Two ticks: one for the fetch promise to resolve, one for the
	// finally-block cleanup inside the stream to run.
	await Promise.resolve();
	await Promise.resolve();
}
