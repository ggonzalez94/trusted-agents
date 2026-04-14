import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStream } from "../../lib/events.js";

class FakeEventSource {
	public onopen: (() => void) | null = null;
	public onerror: ((e: unknown) => void) | null = null;
	public onmessage: ((e: MessageEvent) => void) | null = null;
	public readyState = 0;
	public closed = false;
	private listeners = new Map<string, (e: MessageEvent) => void>();

	constructor(public readonly url: string) {
		queueMicrotask(() => {
			this.readyState = 1;
			this.onopen?.();
		});
	}

	addEventListener(type: string, handler: (e: MessageEvent) => void): void {
		this.listeners.set(type, handler);
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
		this.listeners.get(type)?.(event);
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
		const stream = new EventStream(
			"http://localhost:6810",
			"abc-token",
			() => {},
		);
		stream.start();
		expect(createdSources[0].url).toContain("/api/events/stream");
		expect(createdSources[0].url).toContain("token=abc-token");
	});

	it("dispatches typed events to the handler", () => {
		const events: unknown[] = [];
		const stream = new EventStream(
			"http://localhost:6810",
			"abc",
			(event) => events.push(event),
		);
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
		const stream = new EventStream(
			"http://localhost:6810",
			"abc",
			() => {},
		);
		stream.start();
		stream.stop();
		expect(createdSources[0].closed).toBe(true);
	});

	it("sends lastEventId on reconnect after seeing an event", () => {
		const stream = new EventStream(
			"http://localhost:6810",
			"abc",
			() => {},
		);
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
});
