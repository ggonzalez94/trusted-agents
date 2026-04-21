import { describe, expect, it } from "vitest";
import {
	type TapEmitEventPayload,
	classifyTapEvent,
} from "../../../src/runtime/event-classifier.js";

function makeEvent(overrides: Partial<TapEmitEventPayload> = {}): TapEmitEventPayload {
	return {
		direction: "incoming",
		from: 42,
		method: "message/send",
		id: "req-1",
		receipt_status: "delivered",
		...overrides,
	};
}

describe("classifyTapEvent", () => {
	it("returns null for outgoing events", () => {
		expect(classifyTapEvent(makeEvent({ direction: "outgoing" }))).toBeNull();
	});

	it("returns null for duplicate events", () => {
		expect(classifyTapEvent(makeEvent({ receipt_status: "duplicate" }))).toBeNull();
	});

	it("returns auto-handle for message/send, action/result, permissions/update", () => {
		expect(classifyTapEvent(makeEvent({ method: "message/send" }))).toBe("auto-handle");
		expect(classifyTapEvent(makeEvent({ method: "action/result" }))).toBe("auto-handle");
		expect(classifyTapEvent(makeEvent({ method: "permissions/update" }))).toBe("auto-handle");
	});

	it("returns null for connection/request (auto-accepted)", () => {
		expect(classifyTapEvent(makeEvent({ method: "connection/request" }))).toBeNull();
	});

	it("returns notify for connection/result", () => {
		expect(classifyTapEvent(makeEvent({ method: "connection/result" }))).toBe("notify");
	});

	it("returns auto-handle for action/request with receipt_status received", () => {
		expect(
			classifyTapEvent(makeEvent({ method: "action/request", receipt_status: "received" })),
		).toBe("auto-handle");
	});

	it("returns null for action/request with receipt_status queued (handled by hooks)", () => {
		expect(
			classifyTapEvent(makeEvent({ method: "action/request", receipt_status: "queued" })),
		).toBeNull();
	});

	it("returns escalate for scheduling/propose, counter, accept, cancel", () => {
		expect(classifyTapEvent(makeEvent({ method: "scheduling/propose" }))).toBe("escalate");
		expect(classifyTapEvent(makeEvent({ method: "scheduling/counter" }))).toBe("escalate");
		expect(classifyTapEvent(makeEvent({ method: "scheduling/accept" }))).toBe("escalate");
		expect(classifyTapEvent(makeEvent({ method: "scheduling/cancel" }))).toBe("escalate");
	});

	it("returns auto-handle for scheduling/reject", () => {
		expect(classifyTapEvent(makeEvent({ method: "scheduling/reject" }))).toBe("auto-handle");
	});

	it("returns null for unknown methods", () => {
		expect(classifyTapEvent(makeEvent({ method: "unknown/method" }))).toBeNull();
	});
});
