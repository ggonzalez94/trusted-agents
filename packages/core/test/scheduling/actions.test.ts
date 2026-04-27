import { describe, expect, it } from "vitest";
import { ACTION_REQUEST, ACTION_RESULT } from "../../src/protocol/methods.js";
import {
	buildSchedulingAcceptText,
	buildSchedulingProposalText,
	buildSchedulingRejectText,
	parseSchedulingActionPayload,
	parseSchedulingActionRequest,
	parseSchedulingActionResponse,
} from "../../src/scheduling/actions.js";
import type {
	SchedulingAccept,
	SchedulingProposal,
	SchedulingReject,
} from "../../src/scheduling/types.js";
import type { ProtocolMessage } from "../../src/transport/interface.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSchedulingMessage(
	method: string,
	text: string,
	baseData: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
	resultParams?: Record<string, unknown>,
): ProtocolMessage {
	return {
		jsonrpc: "2.0",
		method,
		params: {
			...resultParams,
			message: {
				parts: [
					{ kind: "text", text },
					{ kind: "data", data: { ...baseData, ...overrides } },
				],
			},
		},
	};
}

function makeProposalMessage(overrides: Record<string, unknown> = {}): ProtocolMessage {
	return makeSchedulingMessage(
		ACTION_REQUEST,
		"Proposing: Dinner (90 min) — 2 time slot(s)",
		{
			type: "scheduling/propose",
			schedulingId: "sch_abc123",
			title: "Dinner",
			duration: 90,
			slots: [
				{ start: "2026-03-28T23:00:00Z", end: "2026-03-29T00:30:00Z" },
				{ start: "2026-03-29T23:00:00Z", end: "2026-03-30T00:30:00Z" },
			],
			originTimezone: "America/New_York",
		},
		overrides,
	);
}

function makeAcceptMessage(overrides: Record<string, unknown> = {}): ProtocolMessage {
	return makeSchedulingMessage(
		ACTION_RESULT,
		"Accepted: meeting at 2026-03-28T23:00:00Z",
		{
			type: "scheduling/accept",
			schedulingId: "sch_abc123",
			acceptedSlot: { start: "2026-03-28T23:00:00Z", end: "2026-03-29T00:30:00Z" },
		},
		overrides,
		{ requestId: "req_123", status: "completed" },
	);
}

function makeRejectMessage(overrides: Record<string, unknown> = {}): ProtocolMessage {
	return makeSchedulingMessage(
		ACTION_RESULT,
		"Declined meeting request",
		{ type: "scheduling/reject", schedulingId: "sch_abc123" },
		overrides,
		{ requestId: "req_456", status: "rejected" },
	);
}

function makeCancelMessage(overrides: Record<string, unknown> = {}): ProtocolMessage {
	return makeSchedulingMessage(
		ACTION_RESULT,
		"Cancelled meeting",
		{ type: "scheduling/cancel", schedulingId: "sch_abc123", reason: "No longer needed" },
		overrides,
		{ requestId: "req_789", status: "rejected" },
	);
}

// ── parseSchedulingActionPayload ─────────────────────────────────────────────

describe("parseSchedulingActionPayload", () => {
	it("supports explicit legacy aliases for the runtime fallback parser", () => {
		const result = parseSchedulingActionPayload(
			{
				type: "scheduling/request",
				title: "Dinner",
				durationMinutes: 90,
				proposedSlots: [{ start: "tomorrow morning", end: "tomorrow afternoon", ignored: true }],
				timezone: "America/New_York",
				note: "Bring notes",
				location: "Cafe",
			},
			{
				typeAliases: { "scheduling/request": "scheduling/propose" },
				durationFields: ["durationMinutes", "duration"],
				slotFields: ["proposedSlots", "slots"],
				originTimezoneFields: ["timezone", "originTimezone"],
				defaultSchedulingId: () => "sch_generated",
				defaultOriginTimezone: "UTC",
				copySlots: true,
				includeLocation: false,
				validateSlotDates: false,
			},
		);

		expect(result).toEqual({
			type: "scheduling/propose",
			schedulingId: "sch_generated",
			title: "Dinner",
			duration: 90,
			slots: [{ start: "tomorrow morning", end: "tomorrow afternoon" }],
			originTimezone: "America/New_York",
			note: "Bring notes",
		});
	});

	it("keeps strict slot validation by default", () => {
		const result = parseSchedulingActionPayload({
			type: "scheduling/propose",
			schedulingId: "sch_abc123",
			title: "Dinner",
			duration: 90,
			slots: [{ start: "tomorrow morning", end: "tomorrow afternoon" }],
			originTimezone: "America/New_York",
		});

		expect(result).toBeNull();
	});
});

// ── parseSchedulingActionRequest ─────────────────────────────────────────────

describe("parseSchedulingActionRequest", () => {
	it("parses a valid scheduling/propose message", () => {
		const result = parseSchedulingActionRequest(makeProposalMessage());
		expect(result).not.toBeNull();
		expect(result?.type).toBe("scheduling/propose");
		expect(result?.schedulingId).toBe("sch_abc123");
		expect(result?.title).toBe("Dinner");
		expect(result?.duration).toBe(90);
		expect(result?.slots).toHaveLength(2);
		expect(result?.originTimezone).toBe("America/New_York");
	});

	it("parses a valid scheduling/counter message", () => {
		const result = parseSchedulingActionRequest(
			makeProposalMessage({ type: "scheduling/counter" }),
		);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("scheduling/counter");
	});

	it("includes optional fields when present", () => {
		const result = parseSchedulingActionRequest(
			makeProposalMessage({ location: "Coffee Shop", note: "Let's meet up" }),
		);
		expect(result?.location).toBe("Coffee Shop");
		expect(result?.note).toBe("Let's meet up");
	});

	it("returns null when method is not ACTION_REQUEST", () => {
		const msg: ProtocolMessage = { ...makeProposalMessage(), method: ACTION_RESULT };
		expect(parseSchedulingActionRequest(msg)).toBeNull();
	});

	it("returns null when data type is not scheduling/propose or scheduling/counter", () => {
		expect(
			parseSchedulingActionRequest(makeProposalMessage({ type: "scheduling/accept" })),
		).toBeNull();
	});

	it("returns null when schedulingId is missing", () => {
		const msg = makeProposalMessage({ schedulingId: undefined });
		// Remove the key entirely so it's missing
		const params = msg.params as Record<string, unknown>;
		const message = params.message as Record<string, unknown>;
		const parts = message.parts as Array<Record<string, unknown>>;
		const data = parts[1].data as Record<string, unknown>;
		data.schedulingId = undefined;
		expect(parseSchedulingActionRequest(msg)).toBeNull();
	});

	it.each([
		["schedulingId is empty", { schedulingId: "" }],
		["title is empty", { title: "" }],
		["duration is zero", { duration: 0 }],
		["duration is negative", { duration: -5 }],
		["duration is not a number", { duration: "90" }],
		["slots is empty", { slots: [] }],
		["slots is not an array", { slots: "not-an-array" }],
	] as [string, Record<string, unknown>][])("returns null when %s", (_, overrides) => {
		expect(parseSchedulingActionRequest(makeProposalMessage(overrides))).toBeNull();
	});

	it.each([
		["a slot has invalid start/end", [{ start: "not-a-date", end: "2026-03-29T00:30:00Z" }]],
		["a slot has start >= end", [{ start: "2026-03-29T01:00:00Z", end: "2026-03-28T23:00:00Z" }]],
		["slot is missing start", [{ end: "2026-03-29T00:30:00Z" }]],
	] as [string, unknown[]][])("returns null when %s", (_, slots) => {
		expect(parseSchedulingActionRequest(makeProposalMessage({ slots }))).toBeNull();
	});

	it("returns null when originTimezone is empty", () => {
		expect(parseSchedulingActionRequest(makeProposalMessage({ originTimezone: "" }))).toBeNull();
	});

	it("returns null when params is missing", () => {
		const msg: ProtocolMessage = { jsonrpc: "2.0", method: ACTION_REQUEST };
		expect(parseSchedulingActionRequest(msg)).toBeNull();
	});

	it("returns null when message.parts has no data part", () => {
		const msg: ProtocolMessage = {
			jsonrpc: "2.0",
			method: ACTION_REQUEST,
			params: { message: { parts: [{ kind: "text", text: "hello" }] } },
		};
		expect(parseSchedulingActionRequest(msg)).toBeNull();
	});
});

// ── parseSchedulingActionResponse ────────────────────────────────────────────

describe("parseSchedulingActionResponse — accept", () => {
	it("parses a valid scheduling/accept message", () => {
		const result = parseSchedulingActionResponse(makeAcceptMessage());
		expect(result).not.toBeNull();
		expect(result?.type).toBe("scheduling/accept");
		const accept = result as SchedulingAccept;
		expect(accept.schedulingId).toBe("sch_abc123");
		expect(accept.acceptedSlot.start).toBe("2026-03-28T23:00:00Z");
		expect(accept.acceptedSlot.end).toBe("2026-03-29T00:30:00Z");
	});

	it("includes optional note when present", () => {
		const result = parseSchedulingActionResponse(makeAcceptMessage({ note: "See you there!" }));
		const accept = result as SchedulingAccept;
		expect(accept.note).toBe("See you there!");
	});

	it("returns null when acceptedSlot is missing", () => {
		const msg = makeAcceptMessage();
		const params = msg.params as Record<string, unknown>;
		const message = (params as Record<string, unknown>).message as Record<string, unknown>;
		const parts = message.parts as Array<Record<string, unknown>>;
		const data = parts[1].data as Record<string, unknown>;
		data.acceptedSlot = undefined;
		expect(parseSchedulingActionResponse(msg)).toBeNull();
	});

	it("returns null when acceptedSlot has invalid dates", () => {
		expect(
			parseSchedulingActionResponse(
				makeAcceptMessage({ acceptedSlot: { start: "bad", end: "2026-03-29T00:30:00Z" } }),
			),
		).toBeNull();
	});

	it("returns null when acceptedSlot start >= end", () => {
		expect(
			parseSchedulingActionResponse(
				makeAcceptMessage({
					acceptedSlot: { start: "2026-03-30T00:30:00Z", end: "2026-03-28T23:00:00Z" },
				}),
			),
		).toBeNull();
	});
});

describe("parseSchedulingActionResponse — reject", () => {
	it("parses a valid scheduling/reject message", () => {
		const result = parseSchedulingActionResponse(makeRejectMessage());
		expect(result).not.toBeNull();
		expect(result?.type).toBe("scheduling/reject");
		const reject = result as SchedulingReject;
		expect(reject.schedulingId).toBe("sch_abc123");
		expect(reject.reason).toBeUndefined();
	});

	it("includes optional reason when present", () => {
		const result = parseSchedulingActionResponse(makeRejectMessage({ reason: "Too busy" }));
		const reject = result as SchedulingReject;
		expect(reject.reason).toBe("Too busy");
	});

	it("returns null when schedulingId is empty", () => {
		expect(parseSchedulingActionResponse(makeRejectMessage({ schedulingId: "" }))).toBeNull();
	});
});

describe("parseSchedulingActionResponse — cancel", () => {
	it("parses a valid scheduling/cancel message", () => {
		const result = parseSchedulingActionResponse(makeCancelMessage());
		expect(result).not.toBeNull();
		expect(result?.type).toBe("scheduling/cancel");
		const cancel = result as SchedulingReject;
		expect(cancel.schedulingId).toBe("sch_abc123");
		expect(cancel.reason).toBe("No longer needed");
	});
});

describe("parseSchedulingActionResponse — common failures", () => {
	it("returns null when method is not ACTION_RESULT", () => {
		const msg = { ...makeAcceptMessage(), method: ACTION_REQUEST };
		expect(parseSchedulingActionResponse(msg)).toBeNull();
	});

	it("returns null when requestId is missing", () => {
		const msg = makeAcceptMessage();
		(msg.params as Record<string, unknown>).requestId = undefined;
		expect(parseSchedulingActionResponse(msg)).toBeNull();
	});

	it("returns null when requestId is empty", () => {
		const msg = {
			...makeAcceptMessage(),
			params: { ...makeAcceptMessage().params, requestId: "" },
		};
		expect(parseSchedulingActionResponse(msg)).toBeNull();
	});

	it("returns null when data type is not a scheduling response type", () => {
		const msg = makeAcceptMessage({ type: "transfer/response" });
		expect(parseSchedulingActionResponse(msg)).toBeNull();
	});

	it("returns null when params is missing", () => {
		const msg: ProtocolMessage = { jsonrpc: "2.0", method: ACTION_RESULT };
		expect(parseSchedulingActionResponse(msg)).toBeNull();
	});
});

// ── buildSchedulingProposalText ───────────────────────────────────────────────

describe("buildSchedulingProposalText", () => {
	const proposal: SchedulingProposal = {
		type: "scheduling/propose",
		schedulingId: "sch_abc123",
		title: "Dinner",
		duration: 90,
		slots: [
			{ start: "2026-03-28T23:00:00Z", end: "2026-03-29T00:30:00Z" },
			{ start: "2026-03-29T23:00:00Z", end: "2026-03-30T00:30:00Z" },
		],
		originTimezone: "America/New_York",
	};

	it("returns the expected text for a proposal with multiple slots", () => {
		expect(buildSchedulingProposalText(proposal)).toBe(
			"Proposing: Dinner (90 min) — 2 time slot(s)",
		);
	});

	it("returns the expected text for a proposal with a single slot", () => {
		expect(buildSchedulingProposalText({ ...proposal, slots: [proposal.slots[0]] })).toBe(
			"Proposing: Dinner (90 min) — 1 time slot(s)",
		);
	});

	it("works for counter proposals", () => {
		expect(
			buildSchedulingProposalText({ ...proposal, type: "scheduling/counter", title: "Lunch" }),
		).toBe("Proposing: Lunch (90 min) — 2 time slot(s)");
	});
});

// ── buildSchedulingAcceptText ─────────────────────────────────────────────────

describe("buildSchedulingAcceptText", () => {
	const accept: SchedulingAccept = {
		type: "scheduling/accept",
		schedulingId: "sch_abc123",
		acceptedSlot: { start: "2026-03-28T23:00:00Z", end: "2026-03-29T00:30:00Z" },
	};

	it("returns the expected text", () => {
		expect(buildSchedulingAcceptText(accept)).toBe("Accepted: meeting at 2026-03-28T23:00:00Z");
	});
});

// ── buildSchedulingRejectText ─────────────────────────────────────────────────

describe("buildSchedulingRejectText", () => {
	it("returns base text for reject without reason", () => {
		const reject: SchedulingReject = {
			type: "scheduling/reject",
			schedulingId: "sch_abc123",
		};
		expect(buildSchedulingRejectText(reject)).toBe("Declined meeting request");
	});

	it("appends reason for reject with reason", () => {
		const reject: SchedulingReject = {
			type: "scheduling/reject",
			schedulingId: "sch_abc123",
			reason: "Too busy",
		};
		expect(buildSchedulingRejectText(reject)).toBe("Declined meeting request: Too busy");
	});

	it("returns cancel text without reason", () => {
		const cancel: SchedulingReject = {
			type: "scheduling/cancel",
			schedulingId: "sch_abc123",
		};
		expect(buildSchedulingRejectText(cancel)).toBe("Cancelled meeting");
	});

	it("appends reason for cancel with reason", () => {
		const cancel: SchedulingReject = {
			type: "scheduling/cancel",
			schedulingId: "sch_abc123",
			reason: "No longer needed",
		};
		expect(buildSchedulingRejectText(cancel)).toBe("Cancelled meeting: No longer needed");
	});
});
