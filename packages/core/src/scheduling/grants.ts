import { isObject } from "../common/validation.js";
import type { PermissionGrant, PermissionGrantSet } from "../permissions/types.js";
import { findActiveGrantsByScope } from "../runtime/grants.js";
import type { SchedulingProposal, TimeSlot } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocalDayOfWeek(date: Date, timezone: string): number {
	const formatter = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		timeZone: timezone,
	});
	const dayStr = formatter.format(date).toLowerCase().slice(0, 3);
	const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
	const index = dayNames.indexOf(dayStr);
	return index === -1 ? date.getDay() : index;
}

function toLocalMinutes(isoTime: string, timezone: string): number {
	const date = new Date(isoTime);
	const formatter = new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		minute: "numeric",
		hour12: false,
		timeZone: timezone,
	});
	const localTime = formatter.format(date);
	const [hourStr, minuteStr] = localTime.split(":");
	const hour = Number(hourStr);
	const minute = Number(minuteStr);
	return hour * 60 + minute;
}

function isSlotWithinTimeRange(
	isoStart: string,
	isoEnd: string,
	rangeStart: string,
	rangeEnd: string,
	timezone: string,
): boolean {
	const slotStartMinutes = toLocalMinutes(isoStart, timezone);
	const slotEndMinutes = toLocalMinutes(isoEnd, timezone);

	const rsParts = rangeStart.split(":").map(Number);
	const reParts = rangeEnd.split(":").map(Number);
	const rangeStartMinutes = (rsParts[0] ?? 0) * 60 + (rsParts[1] ?? 0);
	const rangeEndMinutes = (reParts[0] ?? 0) * 60 + (reParts[1] ?? 0);

	return (
		slotStartMinutes >= rangeStartMinutes &&
		slotEndMinutes <= rangeEndMinutes &&
		slotStartMinutes < slotEndMinutes
	);
}

// ── Exports ───────────────────────────────────────────────────────────────────

export function matchesSchedulingConstraints(
	grant: PermissionGrant,
	proposal: SchedulingProposal,
): boolean {
	return filterSchedulingProposalSlots(grant, proposal).length > 0;
}

export function filterSchedulingProposalSlots(
	grant: PermissionGrant,
	proposal: SchedulingProposal,
): TimeSlot[] {
	const constraints = grant.constraints;
	if (!constraints) {
		return [...proposal.slots];
	}

	if (
		typeof constraints.maxDurationMinutes === "number" &&
		proposal.duration > constraints.maxDurationMinutes
	) {
		return [];
	}

	const timezone = typeof constraints.timezone === "string" ? constraints.timezone : "UTC";
	const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

	return proposal.slots.filter((slot) => {
		if (Array.isArray(constraints.allowedDays)) {
			const localDay = getLocalDayOfWeek(new Date(slot.start), timezone);
			if (!constraints.allowedDays.includes(dayNames[localDay])) {
				return false;
			}
		}

		if (isObject(constraints.allowedTimeRange)) {
			const range = constraints.allowedTimeRange;
			if (
				typeof range.start === "string" &&
				typeof range.end === "string" &&
				!isSlotWithinTimeRange(slot.start, slot.end, range.start, range.end, timezone)
			) {
				return false;
			}
		}

		return true;
	});
}

export function findSchedulableSchedulingSlots(
	grants: PermissionGrant[],
	proposal: SchedulingProposal,
): TimeSlot[] {
	return proposal.slots.filter((slot) =>
		grants.some(
			(grant) =>
				filterSchedulingProposalSlots(grant, {
					...proposal,
					slots: [slot],
				}).length > 0,
		),
	);
}

export function findApplicableSchedulingGrants(
	grantSet: PermissionGrantSet,
	proposal: SchedulingProposal,
): PermissionGrant[] {
	return findActiveGrantsByScope(grantSet, "scheduling/request").filter((grant) =>
		matchesSchedulingConstraints(grant, proposal),
	);
}
