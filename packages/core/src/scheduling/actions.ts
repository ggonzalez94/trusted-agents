import { isNonEmptyString, readNonEmptyString } from "../common/index.js";
import { ACTION_REQUEST, ACTION_RESULT } from "../protocol/methods.js";
import { extractMessageData } from "../runtime/actions.js";
import type { ProtocolMessage } from "../transport/interface.js";
import type { SchedulingAccept, SchedulingProposal, SchedulingReject, TimeSlot } from "./types.js";

type SchedulingPayloadParseOptions = {
	defaultSchedulingId?: () => string;
	defaultOriginTimezone?: string;
	copySlots?: boolean;
	includeLocation?: boolean;
};

function isValidIsoDate(value: unknown): value is string {
	if (!isNonEmptyString(value)) {
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

export function parseSchedulingActionPayload(
	data: Record<string, unknown>,
	options: SchedulingPayloadParseOptions = {},
): SchedulingProposal | null {
	if (data.type !== "scheduling/propose" && data.type !== "scheduling/counter") {
		return null;
	}

	const schedulingId = isNonEmptyString(data.schedulingId)
		? data.schedulingId
		: options.defaultSchedulingId?.();
	const originTimezone = isNonEmptyString(data.originTimezone)
		? data.originTimezone
		: options.defaultOriginTimezone;

	if (
		!isNonEmptyString(schedulingId) ||
		!isNonEmptyString(data.title) ||
		typeof data.duration !== "number" ||
		data.duration <= 0 ||
		!isNonEmptyString(originTimezone)
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

	const location =
		options.includeLocation === false ? undefined : readNonEmptyString(data.location);
	const note = readNonEmptyString(data.note);
	const slots = options.copySlots
		? data.slots.map((slot) => {
				const { start, end } = slot as TimeSlot;
				return { start, end };
			})
		: (data.slots as TimeSlot[]);

	return {
		type: data.type,
		schedulingId,
		title: data.title,
		duration: data.duration,
		slots,
		originTimezone,
		...(location ? { location } : {}),
		...(note ? { note } : {}),
	};
}

export function parseSchedulingActionRequest(message: ProtocolMessage): SchedulingProposal | null {
	if (message.method !== ACTION_REQUEST) {
		return null;
	}

	const data = extractMessageData(message);
	return data ? parseSchedulingActionPayload(data) : null;
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

	if (!isNonEmptyString(params.requestId)) {
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

		if (!isNonEmptyString(data.schedulingId)) {
			return null;
		}

		const note = readNonEmptyString(data.note);

		return {
			type: "scheduling/accept",
			schedulingId: data.schedulingId,
			acceptedSlot: data.acceptedSlot as TimeSlot,
			...(note ? { note } : {}),
		};
	}

	if (data.type === "scheduling/reject" || data.type === "scheduling/cancel") {
		if (!isNonEmptyString(data.schedulingId)) {
			return null;
		}

		const reason = readNonEmptyString(data.reason);

		return {
			type: data.type as "scheduling/reject" | "scheduling/cancel",
			schedulingId: data.schedulingId,
			...(reason ? { reason } : {}),
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
