import type { TapEvent } from "trusted-agents-core";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";
import { TapdRuntime } from "../../src/runtime.js";

interface FakeService {
	hooks: { onTypedEvent?: (event: TapEvent) => void };
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
}

function makeService(): FakeService {
	return {
		hooks: {},
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
	};
}

function makeMessageReceivedEvent(overrides?: Partial<TapEvent>): TapEvent {
	return {
		id: "evt-1",
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
		messageId: "msg-1",
		text: "hello",
		scope: "general-chat",
		...(overrides as object),
	} as TapEvent;
}

describe("TapdRuntime", () => {
	it("starts the underlying service on start()", async () => {
		const service = makeService();
		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus: new EventBus({ ringBufferSize: 10 }),
		});
		await runtime.start();
		expect(service.start).toHaveBeenCalledTimes(1);
	});

	it("stops the underlying service on stop()", async () => {
		const service = makeService();
		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus: new EventBus({ ringBufferSize: 10 }),
		});
		await runtime.start();
		await runtime.stop();
		expect(service.stop).toHaveBeenCalledTimes(1);
	});

	it("forwards typed events emitted by the service onto the bus", async () => {
		const service = makeService();
		const bus = new EventBus({ ringBufferSize: 10 });
		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus,
		});
		await runtime.start();

		const captured: TapEvent[] = [];
		bus.subscribe((event) => {
			captured.push(event);
		});

		service.hooks.onTypedEvent?.(makeMessageReceivedEvent());

		expect(captured).toHaveLength(1);
		expect(captured[0]?.type).toBe("message.received");
		if (captured[0]?.type === "message.received") {
			expect(captured[0].text).toBe("hello");
			expect(captured[0].peer.peerAgentId).toBe(99);
		}
	});

	it("preserves any pre-existing onTypedEvent hook and calls it first", async () => {
		const service = makeService();
		const bus = new EventBus({ ringBufferSize: 10 });

		const priorCalls: TapEvent[] = [];
		service.hooks.onTypedEvent = (event) => {
			priorCalls.push(event);
		};

		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus,
		});
		await runtime.start();

		const captured: TapEvent[] = [];
		bus.subscribe((event) => {
			captured.push(event);
		});

		service.hooks.onTypedEvent?.(makeMessageReceivedEvent());

		expect(priorCalls).toHaveLength(1);
		expect(captured).toHaveLength(1);
	});

	it("forwards action.requested events as action.requested on the bus", async () => {
		const service = makeService();
		const bus = new EventBus({ ringBufferSize: 10 });
		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus,
		});
		await runtime.start();

		const captured: TapEvent[] = [];
		bus.subscribe((event) => {
			captured.push(event);
		});

		const event: TapEvent = {
			id: "evt-2",
			occurredAt: "2026-04-13T00:00:00.000Z",
			identityAgentId: 42,
			type: "action.requested",
			conversationId: "conv-1",
			peer: {
				connectionId: "conn-1",
				peerAgentId: 99,
				peerName: "Bob",
				peerChain: "eip155:8453",
			},
			requestId: "req-1",
			kind: "scheduling",
			payload: {},
			direction: "outbound",
		};
		service.hooks.onTypedEvent?.(event);

		expect(captured).toHaveLength(1);
		if (captured[0]?.type === "action.requested") {
			expect(captured[0].kind).toBe("scheduling");
			expect(captured[0].direction).toBe("outbound");
		}
	});
});
