import { describe, expect, it } from "vitest";
import { type TapEmitEventPayload, classifyTapEvent } from "../src/event-classifier.js";

function makeEvent(overrides: Partial<TapEmitEventPayload> = {}): TapEmitEventPayload {
	return {
		direction: "incoming",
		from: 42,
		method: "message/send",
		id: "msg-1",
		receipt_status: "delivered",
		...overrides,
	};
}

describe("classifyTapEvent", () => {
	describe("filtering", () => {
		it("drops duplicate events (receipt_status 'duplicate')", () => {
			const event = makeEvent({ receipt_status: "duplicate" });
			expect(classifyTapEvent(event)).toBeNull();
		});

		it("drops outgoing events (direction !== 'incoming')", () => {
			const event = makeEvent({ direction: "outgoing" });
			expect(classifyTapEvent(event)).toBeNull();
		});

		it("drops events that are both outgoing and duplicate", () => {
			const event = makeEvent({
				direction: "outgoing",
				receipt_status: "duplicate",
			});
			expect(classifyTapEvent(event)).toBeNull();
		});
	});

	describe("auto-handle bucket", () => {
		it("classifies message/send as auto-handle", () => {
			const event = makeEvent({ method: "message/send" });
			expect(classifyTapEvent(event)).toBe("auto-handle");
		});

		it("classifies action/result as auto-handle", () => {
			const event = makeEvent({ method: "action/result" });
			expect(classifyTapEvent(event)).toBe("auto-handle");
		});

		it("classifies permissions/update as auto-handle", () => {
			const event = makeEvent({ method: "permissions/update" });
			expect(classifyTapEvent(event)).toBe("auto-handle");
		});

		it("classifies action/request with receipt_status 'received' as auto-handle (permission grant)", () => {
			const event = makeEvent({
				method: "action/request",
				receipt_status: "received",
			});
			expect(classifyTapEvent(event)).toBe("auto-handle");
		});
	});

	describe("escalate bucket", () => {
		it("classifies connection/request as escalate", () => {
			const event = makeEvent({ method: "connection/request" });
			expect(classifyTapEvent(event)).toBe("escalate");
		});

		it("classifies connection/request as escalate regardless of receipt_status", () => {
			for (const receipt_status of ["delivered", "received", "queued", "ok"]) {
				const event = makeEvent({ method: "connection/request", receipt_status });
				expect(classifyTapEvent(event)).toBe("escalate");
			}
		});

		it("classifies action/request with receipt_status 'queued' as escalate (transfer)", () => {
			const event = makeEvent({
				method: "action/request",
				receipt_status: "queued",
			});
			expect(classifyTapEvent(event)).toBe("escalate");
		});
	});

	describe("notify bucket", () => {
		it("classifies connection/result as notify", () => {
			const event = makeEvent({ method: "connection/result" });
			expect(classifyTapEvent(event)).toBe("notify");
		});
	});

	describe("unknown methods", () => {
		it("returns null for unknown method", () => {
			const event = makeEvent({ method: "foo/bar" });
			expect(classifyTapEvent(event)).toBeNull();
		});

		it("returns null for empty method", () => {
			const event = makeEvent({ method: "" });
			expect(classifyTapEvent(event)).toBeNull();
		});
	});
});
