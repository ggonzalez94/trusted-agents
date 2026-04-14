import type { TapEvent } from "trusted-agents-core";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";
import { TapdRuntime } from "../../src/runtime.js";

interface FakeService {
	hooks: { emitEvent?: (payload: Record<string, unknown>) => void };
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

	it("translates raw emitEvent payloads into typed bus events", async () => {
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

		// Simulate the service emitting a raw payload through its hook.
		service.hooks.emitEvent?.({
			direction: "incoming",
			from: 99,
			method: "message/send",
			id: "req-1",
			receipt_status: "delivered",
			messageText: "hello",
			conversationId: "conv-1",
			peerName: "Bob",
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].type).toBe("message.received");
		expect(captured[0].identityAgentId).toBe(42);
		if (captured[0].type === "message.received") {
			expect(captured[0].text).toBe("hello");
			expect(captured[0].peer.peerAgentId).toBe(99);
		}
	});

	it("emits action.requested for outbound action requests", async () => {
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

		service.hooks.emitEvent?.({
			direction: "outgoing",
			from: 42,
			to: 99,
			method: "action/request",
			id: "req-2",
			receipt_status: "queued",
			actionKind: "transfer",
			conversationId: "conv-1",
			peerName: "Bob",
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].type).toBe("action.requested");
		if (captured[0].type === "action.requested") {
			expect(captured[0].direction).toBe("outbound");
			expect(captured[0].kind).toBe("transfer");
		}
	});

	it("ignores unknown raw payloads silently", async () => {
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

		service.hooks.emitEvent?.({
			direction: "weird",
			from: 99,
			method: "totally/unknown",
			id: "x",
			receipt_status: "?",
		});

		expect(captured).toHaveLength(0);
	});
});
