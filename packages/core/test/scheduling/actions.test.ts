import { describe, expect, it } from "vitest";
import { ACTION_REQUEST, ACTION_RESULT } from "../../src/protocol/methods.js";
import type { ProtocolMessage } from "../../src/transport/interface.js";
import {
	buildSchedulingAcceptText,
	buildSchedulingProposalText,
	buildSchedulingRejectText,
	parseSchedulingActionRequest,
	parseSchedulingActionResponse,
} from "../../src/scheduling/actions.js";
import type { SchedulingAccept, SchedulingProposal, SchedulingReject } from "../../src/scheduling/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProposalMessage(overrides: Record<string, unknown> = {}): ProtocolMessage {
	return {
		jsonrpc: "2.0",
		method: ACTION_REQUEST,
		params: {
			message: {
				parts: [
					{ kind: "text", text: "Proposing: Dinner (90 min) — 2 time slot(s)" },
					{
						kind: "data",
						data: {
							type: "scheduling/propose",
							schedulingId: "sch_abc123",
							title: "Dinner",
							duration: 90,
							slots: [
								{ start: "2026-03-28T23:00:00Z", end: "2026-03-29T00:30:00Z" },
								{ start: "2026-03-29T23:00:00Z", end: "2026-03-30T00:30:00Z" },
							],
							originTimezone: "America/New_York",
							...overrides,
						},
					},
				],
			},
		},
	};
}

function makeAcceptMessage(overrides: Record<string, unknown> = {}): ProtocolMessage {
	return {
		jsonrpc: "2.0",
		method: ACTION_RESULT,
		params: {
			requestId: "req_123",
			status: "completed",
			message: {
				parts: [
					{ kind: "text", text: "Accepted: meeting at 2026-03-28T23:00:00Z" },
					{
						kind: "data",
						data: {
							type: "scheduling/accept",
							schedulingId: "sch_abc123",
							acceptedSlot: { start: "2026-03-28T23:00:00Z", end: "2026-03-29T00:30:00Z" },
							...overrides,
						},
					},
				],
			},
		},
	};
}

function makeRejectMessage(overrides: Record<string, unknown> = {}): ProtocolMessage {
	return {
		jsonrpc: "2.0",
		method: ACTION_RESULT,
		params: {
			requestId: "req_456",
			status: "rejected",
			message: {
				parts: [
					{ kind: "text", text: "Declined meeting request" },
					{
						kind: "data",
						data: {
							type: "scheduling/reject",
							schedulingId: "sch_abc123",
							...overrides,
						},
					},
				],
			},
		},
	};
}

function makeCancelMessage(overrides: Record<string, unknown> = {}): ProtocolMessage {
	return {
		jsonrpc: "2.0",
		method: ACTION_RESULT,
		params: {
			requestId: "req_789",
			status: "rejected",
			message: {
				parts: [
					{ kind: "text", text: "Cancelled meeting" },
					{
						kind: "data",
						data: {
							type: "scheduling/cancel",
							schedulingId: "sch_abc123",
							reason: "No longer needed",
							...overrides,
						},
					},
				],
			},
		},
	};
}

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
		const result = parseSchedulingActionRequest(makeProposalMessage({ type: "scheduling/counter" }));
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
		expect(parseSchedulingActionRequest(makeProposalMessage({ type: "scheduling/accept" }))).toBeNull();
	});

	it("returns null when schedulingId is missing", () => {
		const msg = makeProposalMessage({ schedulingId: undefined });
		// Remove the key entirely so it's missing
		const data = (msg.params as any).message.parts[1].data;
		delete data.schedulingId;
		expect(parseSchedulingActionRequest(msg)).toBeNull();
	});

	it("returns null when schedulingId is empty", () => {
		expect(parseSchedulingActionRequest(makeProposalMessage({ schedulingId: "" }))).toBeNull();
	});

	it("returns null when title is empty", () => {
		expect(parseSchedulingActionRequest(makeProposalMessage({ title: "" }))).toBeNull();
	});

	it("returns null when duration is zero", () => {
		expect(parseSchedulingActionRequest(makeProposalMessage({ duration: 0 }))).toBeNull();
	});

	it("returns null when duration is negative", () => {
		expect(parseSchedulingActionRequest(makeProposalMessage({ duration: -5 }))).toBeNull();
	});

	it("returns null when duration is not a number", () => {
		expect(parseSchedulingActionRequest(makeProposalMessage({ duration: "90" }))).toBeNull();
	});

	it("returns null when slots is empty", () => {
		expect(parseSchedulingActionRequest(makeProposalMessage({ slots: [] }))).toBeNull();
	});

	it("returns null when slots is not an array", () => {
		expect(parseSchedulingActionRequest(makeProposalMessage({ slots: "not-an-array" }))).toBeNull();
	});

	it("returns null when a slot has invalid start/end", () => {
		expect(
			parseSchedulingActionRequest(
				makeProposalMessage({
					slots: [{ start: "not-a-date", end: "2026-03-29T00:30:00Z" }],
				}),
			),
		).toBeNull();
	});

	it("returns null when a slot has start >= end", () => {
		expect(
			parseSchedulingActionRequest(
				makeProposalMessage({
					slots: [{ start: "2026-03-29T01:00:00Z", end: "2026-03-28T23:00:00Z" }],
				}),
			),
		).toBeNull();
	});

	it("returns null when slot is missing start", () => {
		expect(
			parseSchedulingActionRequest(
				makeProposalMessage({
					slots: [{ end: "2026-03-29T00:30:00Z" }],
				}),
			),
		).toBeNull();
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
		const data = (msg.params as any).message.parts[1].data;
		delete data.acceptedSlot;
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
		delete (msg.params as any).requestId;
		expect(parseSchedulingActionResponse(msg)).toBeNull();
	});

	it("returns null when requestId is empty", () => {
		const msg = { ...makeAcceptMessage(), params: { ...makeAcceptMessage().params, requestId: "" } };
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
		expect(buildSchedulingProposalText({ ...proposal, type: "scheduling/counter", title: "Lunch" })).toBe(
			"Proposing: Lunch (90 min) — 2 time slot(s)",
		);
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
		expect(buildSchedulingAcceptText(accept)).toBe(
			"Accepted: meeting at 2026-03-28T23:00:00Z",
		);
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
