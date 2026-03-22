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

	it("throws when start === end", () => {
		expect(() =>
			validateTimeSlot({ start: "2026-04-01T09:00:00Z", end: "2026-04-01T09:00:00Z" }),
		).toThrow();
	});

	it("throws when start > end", () => {
		expect(() =>
			validateTimeSlot({ start: "2026-04-01T11:00:00Z", end: "2026-04-01T09:00:00Z" }),
		).toThrow();
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

	it("throws on invalid type", () => {
		expect(() =>
			validateSchedulingProposal({ ...validProposal, type: "scheduling/accept" as never }),
		).toThrow();
	});

	it("throws on empty title", () => {
		expect(() => validateSchedulingProposal({ ...validProposal, title: "" })).toThrow();
	});

	it("throws on zero duration", () => {
		expect(() => validateSchedulingProposal({ ...validProposal, duration: 0 })).toThrow();
	});

	it("throws on negative duration", () => {
		expect(() => validateSchedulingProposal({ ...validProposal, duration: -5 })).toThrow();
	});

	it("throws on empty slots array", () => {
		expect(() => validateSchedulingProposal({ ...validProposal, slots: [] })).toThrow();
	});

	it("throws when a slot has start >= end", () => {
		expect(() =>
			validateSchedulingProposal({
				...validProposal,
				slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T09:00:00Z" }],
			}),
		).toThrow();
	});

	it("throws on empty originTimezone", () => {
		expect(() => validateSchedulingProposal({ ...validProposal, originTimezone: "" })).toThrow();
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

	it("throws on wrong type", () => {
		expect(() =>
			validateSchedulingAccept({ ...validAccept, type: "scheduling/reject" as never }),
		).toThrow();
	});

	it("throws on empty schedulingId", () => {
		expect(() => validateSchedulingAccept({ ...validAccept, schedulingId: "" })).toThrow();
	});

	it("throws on invalid acceptedSlot", () => {
		expect(() =>
			validateSchedulingAccept({
				...validAccept,
				acceptedSlot: { start: "2026-04-01T10:00:00Z", end: "2026-04-01T09:00:00Z" },
			}),
		).toThrow();
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
