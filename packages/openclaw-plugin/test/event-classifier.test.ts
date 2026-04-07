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
		it.each([
			["duplicate events", { receipt_status: "duplicate" }],
			["outgoing events", { direction: "outgoing" as const }],
			[
				"outgoing + duplicate events",
				{ direction: "outgoing" as const, receipt_status: "duplicate" },
			],
		])("drops %s", (_, overrides) => {
			expect(classifyTapEvent(makeEvent(overrides))).toBeNull();
		});
	});

	describe("auto-handle bucket", () => {
		it.each([
			["message/send", { method: "message/send" }],
			["action/result", { method: "action/result" }],
			["permissions/update", { method: "permissions/update" }],
			[
				"action/request with received status",
				{ method: "action/request", receipt_status: "received" },
			],
		])("classifies %s as auto-handle", (_, overrides) => {
			expect(classifyTapEvent(makeEvent(overrides))).toBe("auto-handle");
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
	});

	describe("transfer requests owned by approveTransfer hook", () => {
		it("returns null for action/request with receipt_status 'queued' (notification owned by approveTransfer hook)", () => {
			const event = makeEvent({
				method: "action/request",
				receipt_status: "queued",
			});
			expect(classifyTapEvent(event)).toBeNull();
		});
	});

	describe("notify bucket", () => {
		it("classifies connection/result as notify", () => {
			const event = makeEvent({ method: "connection/result" });
			expect(classifyTapEvent(event)).toBe("notify");
		});
	});

	describe("unknown methods", () => {
		it.each(["foo/bar", ""])("returns null for unknown method '%s'", (method) => {
			expect(classifyTapEvent(makeEvent({ method }))).toBeNull();
		});
	});
});
