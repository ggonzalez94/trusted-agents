import { describe, expect, it } from "vitest";
import {
	generateSchedulingId,
	validateSchedulingAccept,
	validateSchedulingProposal,
	validateSchedulingReject,
	validateTimeSlot,
} from "../../src/scheduling/types.js";

describe("generateSchedulingId", () => {
	it("matches the expected format", () => {
		const id = generateSchedulingId();
		expect(id).toMatch(/^sch_[a-zA-Z0-9_-]{20}$/);
	});

	it("generates unique ids", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateSchedulingId()));
		expect(ids.size).toBe(100);
	});
});

describe("validateTimeSlot", () => {
	it("accepts a valid slot where start < end", () => {
		expect(() =>
			validateTimeSlot({ start: "2026-04-01T09:00:00Z", end: "2026-04-01T10:00:00Z" }),
		).not.toThrow();
	});

	it.each([
		["start === end", "2026-04-01T09:00:00Z", "2026-04-01T09:00:00Z"],
		["start > end", "2026-04-01T11:00:00Z", "2026-04-01T09:00:00Z"],
	])("throws when %s", (_, start, end) => {
		expect(() => validateTimeSlot({ start, end })).toThrow();
	});
});

describe("validateSchedulingProposal", () => {
	const validProposal = {
		type: "scheduling/propose" as const,
		schedulingId: "sch_abc12345678901234567",
		title: "Sync meeting",
		duration: 30,
		slots: [{ start: "2026-04-01T09:00:00Z", end: "2026-04-01T09:30:00Z" }],
		originTimezone: "America/New_York",
	};

	it("accepts a valid proposal", () => {
		expect(() => validateSchedulingProposal(validProposal)).not.toThrow();
	});

	it("accepts a counter proposal", () => {
		expect(() =>
			validateSchedulingProposal({ ...validProposal, type: "scheduling/counter" }),
		).not.toThrow();
	});

	it.each([
		["invalid type", { type: "scheduling/accept" as never }],
		["empty title", { title: "" }],
		["zero duration", { duration: 0 }],
		["negative duration", { duration: -5 }],
		["empty slots", { slots: [] as never[] }],
		[
			"slot with start >= end",
			{ slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T09:00:00Z" }] },
		],
		["empty originTimezone", { originTimezone: "" }],
	])("throws on %s", (_, override) => {
		expect(() => validateSchedulingProposal({ ...validProposal, ...override })).toThrow();
	});
});

describe("validateSchedulingAccept", () => {
	const validAccept = {
		type: "scheduling/accept" as const,
		schedulingId: "sch_abc12345678901234567",
		acceptedSlot: { start: "2026-04-01T09:00:00Z", end: "2026-04-01T09:30:00Z" },
	};

	it("accepts a valid accept payload", () => {
		expect(() => validateSchedulingAccept(validAccept)).not.toThrow();
	});

	it.each([
		["wrong type", { type: "scheduling/reject" as never }],
		["empty schedulingId", { schedulingId: "" }],
		[
			"invalid acceptedSlot",
			{ acceptedSlot: { start: "2026-04-01T10:00:00Z", end: "2026-04-01T09:00:00Z" } },
		],
	])("throws on %s", (_, override) => {
		expect(() => validateSchedulingAccept({ ...validAccept, ...override })).toThrow();
	});
});

describe("validateSchedulingReject", () => {
	const validReject = {
		type: "scheduling/reject" as const,
		schedulingId: "sch_abc12345678901234567",
	};

	it("accepts a valid reject payload", () => {
		expect(() => validateSchedulingReject(validReject)).not.toThrow();
	});

	it("accepts a cancel payload", () => {
		expect(() =>
			validateSchedulingReject({ ...validReject, type: "scheduling/cancel" }),
		).not.toThrow();
	});

	it("throws on wrong type", () => {
		expect(() =>
			validateSchedulingReject({ ...validReject, type: "scheduling/accept" as never }),
		).toThrow();
	});

	it("throws on empty schedulingId", () => {
		expect(() => validateSchedulingReject({ ...validReject, schedulingId: "" })).toThrow();
	});
});
