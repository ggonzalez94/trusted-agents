import { describe, expect, it } from "vitest";
import { classifyTapEvent } from "../src/hermes/event-classifier.js";

describe("Hermes TAP event classifier", () => {
	it("escalates queued scheduling action requests", () => {
		expect(
			classifyTapEvent({
				direction: "incoming",
				from: 7,
				method: "action/request",
				id: "req-1",
				receipt_status: "queued",
				scope: "scheduling/request",
			}),
		).toBe("escalate");
	});

	it("keeps queued non-scheduling action requests unclassified", () => {
		expect(
			classifyTapEvent({
				direction: "incoming",
				from: 7,
				method: "action/request",
				id: "req-1",
				receipt_status: "queued",
			}),
		).toBeNull();
	});
});
