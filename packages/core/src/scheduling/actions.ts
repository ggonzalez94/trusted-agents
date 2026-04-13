import { ACTION_REQUEST, ACTION_RESULT } from "../protocol/methods.js";
import { extractMessageData } from "../runtime/actions.js";
import type { ProtocolMessage } from "../transport/interface.js";
import type { SchedulingAccept, SchedulingProposal, SchedulingReject, TimeSlot } from "./types.js";

function isValidIsoDate(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) {
		return false;
	}
	const d = new Date(value);
	return !Number.isNaN(d.getTime());
}

function isValidTimeSlot(slot: unknown): slot is TimeSlot {
	if (typeof slot !== "object" || slot === null) {
		return false;
	}
	const s = slot as { start?: unknown; end?: unknown };
	if (!isValidIsoDate(s.start) || !isValidIsoDate(s.end)) {
		return false;
	}
	return new Date(s.start as string) < new Date(s.end as string);
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export function parseSchedulingActionRequest(message: ProtocolMessage): SchedulingProposal | null {
	if (message.method !== ACTION_REQUEST) {
		return null;
	}

	const data = extractMessageData(message);
	if (!data || (data.type !== "scheduling/propose" && data.type !== "scheduling/counter")) {
		return null;
	}

	if (
		typeof data.schedulingId !== "string" ||
		data.schedulingId.length === 0 ||
		typeof data.title !== "string" ||
		data.title.length === 0 ||
		typeof data.duration !== "number" ||
		data.duration <= 0 ||
		typeof data.originTimezone !== "string" ||
		data.originTimezone.length === 0
	) {
		return null;
	}

	if (!Array.isArray(data.slots) || data.slots.length === 0) {
		return null;
	}

	for (const slot of data.slots) {
		if (!isValidTimeSlot(slot)) {
			return null;
		}
	}

	return {
		type: data.type as "scheduling/propose" | "scheduling/counter",
		schedulingId: data.schedulingId,
		title: data.title,
		duration: data.duration,
		slots: data.slots as TimeSlot[],
		originTimezone: data.originTimezone,
		...(typeof data.location === "string" && data.location.length > 0
			? { location: data.location }
			: {}),
		...(typeof data.note === "string" && data.note.length > 0 ? { note: data.note } : {}),
	};
}

export function parseSchedulingActionResponse(
	message: ProtocolMessage,
): SchedulingAccept | SchedulingReject | null {
	if (message.method !== ACTION_RESULT) {
		return null;
	}

	if (typeof message.params !== "object" || message.params === null) {
		return null;
	}

	const params = message.params as {
		requestId?: unknown;
		status?: unknown;
		message?: unknown;
	};

	if (typeof params.requestId !== "string" || params.requestId.length === 0) {
		return null;
	}

	const data = extractMessageData({
		...message,
		params: { message: params.message },
	});

	if (!data) {
		return null;
	}

	if (data.type === "scheduling/accept") {
		if (!isValidTimeSlot(data.acceptedSlot)) {
			return null;
		}

		if (typeof data.schedulingId !== "string" || data.schedulingId.length === 0) {
			return null;
		}

		return {
			type: "scheduling/accept",
			schedulingId: data.schedulingId,
			acceptedSlot: data.acceptedSlot as TimeSlot,
			...(typeof data.note === "string" && data.note.length > 0 ? { note: data.note } : {}),
		};
	}

	if (data.type === "scheduling/reject" || data.type === "scheduling/cancel") {
		if (typeof data.schedulingId !== "string" || data.schedulingId.length === 0) {
			return null;
		}

		return {
			type: data.type as "scheduling/reject" | "scheduling/cancel",
			schedulingId: data.schedulingId,
			...(typeof data.reason === "string" && data.reason.length > 0 ? { reason: data.reason } : {}),
		};
	}

	return null;
}

// ── Text builders ─────────────────────────────────────────────────────────────

export function buildSchedulingProposalText(proposal: SchedulingProposal): string {
	return `Proposing: ${proposal.title} (${proposal.duration} min) — ${proposal.slots.length} time slot(s)`;
}

export function buildSchedulingAcceptText(accept: SchedulingAccept): string {
	return `Accepted: meeting at ${accept.acceptedSlot.start}`;
}

export function buildSchedulingRejectText(reject: SchedulingReject): string {
	const base =
		reject.type === "scheduling/cancel" ? "Cancelled meeting" : "Declined meeting request";
	return reject.reason ? `${base}: ${reject.reason}` : base;
}
