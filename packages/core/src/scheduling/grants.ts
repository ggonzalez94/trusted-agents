import { findActiveGrantsByScope } from "../runtime/grants.js";
import type { PermissionGrant, PermissionGrantSet } from "../permissions/types.js";
import type { SchedulingProposal } from "./types.js";

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

function isSlotWithinTimeRange(
	isoStart: string,
	rangeStart: string,
	rangeEnd: string,
	timezone: string,
): boolean {
	const date = new Date(isoStart);
	const formatter = new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		minute: "numeric",
		hour12: false,
		timeZone: timezone,
	});
	const localTime = formatter.format(date);
	// localTime format: "HH:MM" (24h), e.g. "14:30"
	// Normalize to "HH:MM" in case hour is single digit
	const [hourStr, minuteStr] = localTime.split(":");
	const hour = Number(hourStr);
	const minute = Number(minuteStr);
	const totalMinutes = hour * 60 + minute;

	const rsParts = rangeStart.split(":").map(Number);
	const reParts = rangeEnd.split(":").map(Number);
	const rangeStartMinutes = (rsParts[0] ?? 0) * 60 + (rsParts[1] ?? 0);
	const rangeEndMinutes = (reParts[0] ?? 0) * 60 + (reParts[1] ?? 0);

	return totalMinutes >= rangeStartMinutes && totalMinutes < rangeEndMinutes;
}

// ── Exports ───────────────────────────────────────────────────────────────────

export function matchesSchedulingConstraints(
	grant: PermissionGrant,
	proposal: SchedulingProposal,
): boolean {
	const constraints = grant.constraints;
	if (!constraints) return true;

	// 1. maxDurationMinutes — proposal.duration must be <= max
	if (typeof constraints.maxDurationMinutes === "number") {
		if (proposal.duration > constraints.maxDurationMinutes) return false;
	}

	const timezone = typeof constraints.timezone === "string" ? constraints.timezone : "UTC";

	// 2. allowedDays — all slot start days must be in the list
	if (Array.isArray(constraints.allowedDays)) {
		const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
		for (const slot of proposal.slots) {
			const localDay = getLocalDayOfWeek(new Date(slot.start), timezone);
			if (!constraints.allowedDays.includes(dayNames[localDay])) return false;
		}
	}

	// 3. allowedTimeRange — all slot start times must be within the range
	if (constraints.allowedTimeRange && typeof constraints.allowedTimeRange === "object") {
		const range = constraints.allowedTimeRange as { start?: string; end?: string };
		if (typeof range.start === "string" && typeof range.end === "string") {
			for (const slot of proposal.slots) {
				if (!isSlotWithinTimeRange(slot.start, range.start, range.end, timezone)) return false;
			}
		}
	}

	return true;
}

export function findApplicableSchedulingGrants(
	grantSet: PermissionGrantSet,
	proposal: SchedulingProposal,
): PermissionGrant[] {
	return findActiveGrantsByScope(grantSet, "scheduling/request").filter((grant) =>
		matchesSchedulingConstraints(grant, proposal),
	);
}
