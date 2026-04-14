import type { TapEvent } from "trusted-agents-core";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";

function makeEvent(seq: number): TapEvent {
	return {
		id: `evt-${seq}`,
		type: "daemon.status",
		occurredAt: new Date().toISOString(),
		identityAgentId: 1,
		transportConnected: true,
	};
}

describe("EventBus", () => {
	it("delivers published events to live subscribers", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		const handler = vi.fn();
		bus.subscribe(handler);

		const event = makeEvent(1);
		bus.publish(event);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(event);
	});

	it("does not deliver to handlers added after publish", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		bus.publish(makeEvent(1));

		const handler = vi.fn();
		bus.subscribe(handler);

		expect(handler).not.toHaveBeenCalled();
	});

	it("returns an unsubscribe function that stops delivery", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		const handler = vi.fn();
		const unsubscribe = bus.subscribe(handler);
		unsubscribe();
		bus.publish(makeEvent(1));
		expect(handler).not.toHaveBeenCalled();
	});

	it("retains events in a ring buffer up to its capacity", () => {
		const bus = new EventBus({ ringBufferSize: 3 });
		bus.publish(makeEvent(1));
		bus.publish(makeEvent(2));
		bus.publish(makeEvent(3));
		bus.publish(makeEvent(4));

		expect(bus.snapshot().map((e) => e.id)).toEqual(["evt-2", "evt-3", "evt-4"]);
	});

	it("replays events after a given event id", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		bus.publish(makeEvent(1));
		bus.publish(makeEvent(2));
		bus.publish(makeEvent(3));

		expect(bus.replayAfter("evt-1").map((e) => e.id)).toEqual(["evt-2", "evt-3"]);
	});

	it("replays everything when last event id is unknown", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		bus.publish(makeEvent(1));
		bus.publish(makeEvent(2));

		expect(bus.replayAfter("evt-unknown").map((e) => e.id)).toEqual(["evt-1", "evt-2"]);
	});

	it("returns empty replay when no events published", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		expect(bus.replayAfter(undefined).map((e) => e.id)).toEqual([]);
	});

	it("isolates errors thrown by one handler from other handlers", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		const failing = vi.fn(() => {
			throw new Error("boom");
		});
		const ok = vi.fn();
		bus.subscribe(failing);
		bus.subscribe(ok);

		bus.publish(makeEvent(1));

		expect(failing).toHaveBeenCalledTimes(1);
		expect(ok).toHaveBeenCalledTimes(1);
	});
});
