import { isNonEmptyString, readNonEmptyString } from "../common/index.js";
import { ACTION_REQUEST, ACTION_RESULT } from "../protocol/methods.js";
import { extractMessageData } from "../runtime/actions.js";
import type { ProtocolMessage } from "../transport/interface.js";
import type { SchedulingAccept, SchedulingProposal, SchedulingReject, TimeSlot } from "./types.js";

type SchedulingProposalType = "scheduling/propose" | "scheduling/counter";

type SchedulingPayloadParseOptions = {
	defaultSchedulingId?: () => string;
	defaultOriginTimezone?: string;
	copySlots?: boolean;
	includeLocation?: boolean;
	typeAliases?: Record<string, SchedulingProposalType>;
	durationFields?: readonly string[];
	slotFields?: readonly string[];
	originTimezoneFields?: readonly string[];
	validateSlotDates?: boolean;
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

function isStringTimeSlot(slot: unknown): slot is TimeSlot {
	if (typeof slot !== "object" || slot === null) {
		return false;
	}
	const s = slot as { start?: unknown; end?: unknown };
	return typeof s.start === "string" && typeof s.end === "string";
}

function readFirstNumber(
	data: Record<string, unknown>,
	fields: readonly string[],
): number | undefined {
	for (const field of fields) {
		const value = data[field];
		if (typeof value === "number") return value;
	}
	return undefined;
}

function readFirstArray(
	data: Record<string, unknown>,
	fields: readonly string[],
): unknown[] | undefined {
	for (const field of fields) {
		const value = data[field];
		if (Array.isArray(value)) return value;
	}
	return undefined;
}

function readFirstNonEmptyString(
	data: Record<string, unknown>,
	fields: readonly string[],
): string | undefined {
	for (const field of fields) {
		const value = data[field];
		if (isNonEmptyString(value)) return value;
	}
	return undefined;
}

function readSchedulingProposalType(
	value: unknown,
	aliases: Record<string, SchedulingProposalType> = {},
): SchedulingProposalType | null {
	if (value === "scheduling/propose" || value === "scheduling/counter") {
		return value;
	}
	return typeof value === "string" ? (aliases[value] ?? null) : null;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export function parseSchedulingActionPayload(
	data: Record<string, unknown>,
	options: SchedulingPayloadParseOptions = {},
): SchedulingProposal | null {
	const type = readSchedulingProposalType(data.type, options.typeAliases);
	if (!type) {
		return null;
	}

	const schedulingId = isNonEmptyString(data.schedulingId)
		? data.schedulingId
		: options.defaultSchedulingId?.();
	const originTimezone =
		readFirstNonEmptyString(data, options.originTimezoneFields ?? ["originTimezone"]) ??
		options.defaultOriginTimezone;
	const duration = readFirstNumber(data, options.durationFields ?? ["duration"]);

	if (
		!isNonEmptyString(schedulingId) ||
		!isNonEmptyString(data.title) ||
		duration === undefined ||
		duration <= 0 ||
		!isNonEmptyString(originTimezone)
	) {
		return null;
	}

	const rawSlots = readFirstArray(data, options.slotFields ?? ["slots"]);
	if (!rawSlots || rawSlots.length === 0) {
		return null;
	}

	const isValidSlot = options.validateSlotDates === false ? isStringTimeSlot : isValidTimeSlot;
	for (const slot of rawSlots) {
		if (!isValidSlot(slot)) {
			return null;
		}
	}

	const location =
		options.includeLocation === false ? undefined : readNonEmptyString(data.location);
	const note = readNonEmptyString(data.note);
	const slots = options.copySlots
		? rawSlots.map((slot) => {
				const { start, end } = slot as TimeSlot;
				return { start, end };
			})
		: (rawSlots as TimeSlot[]);

	return {
		type,
		schedulingId,
		title: data.title,
		duration,
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
