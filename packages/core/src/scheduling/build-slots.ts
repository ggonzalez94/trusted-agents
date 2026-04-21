import { ValidationError } from "../common/errors.js";
import type { ICalendarProvider } from "./calendar-provider.js";
import type { TimeSlot } from "./types.js";

/**
 * Pure helper that builds a list of `TimeSlot`s for a scheduling proposal.
 *
 * This was lifted out of `packages/cli/src/commands/message-request-meeting.ts`
 * so that both the CLI command AND tapd's `/api/meetings` flat-shape route can
 * share one implementation. The helper does no IO on its own — it takes an
 * optional `ICalendarProvider` as an argument so callers can plug in whatever
 * provider they already resolved (Google Calendar in the CLI today, `null` in
 * tapd until a shared calendar resolver lands in core).
 *
 * Behavior:
 *   - No `preferred`              → a single placeholder slot starting 24h
 *                                    from now with the requested duration.
 *   - `preferred` + no calendar   → a single slot anchored at the preferred
 *                                    time.
 *   - `preferred` + calendar      → probes the provider's availability ±2h/+4h
 *                                    around preferred, keeps free windows that
 *                                    can fit the meeting, and sorts by
 *                                    proximity to the preferred time. Falls
 *                                    back to the single-placeholder slot if
 *                                    every window is busy.
 */
export async function buildSchedulingSlots(
	preferred: string | undefined,
	durationMinutes: number,
	calendarProvider: ICalendarProvider | null,
): Promise<TimeSlot[]> {
	if (!preferred) {
		const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
		const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
		return [{ start: start.toISOString(), end: end.toISOString() }];
	}

	const preferredDate = new Date(preferred);
	if (Number.isNaN(preferredDate.getTime())) {
		throw new ValidationError(`Invalid preferred time: ${preferred}. Use ISO 8601 format.`);
	}

	if (!calendarProvider) {
		const end = new Date(preferredDate.getTime() + durationMinutes * 60 * 1000);
		return [{ start: preferredDate.toISOString(), end: end.toISOString() }];
	}

	const windowStart = new Date(preferredDate.getTime() - 2 * 60 * 60 * 1000);
	const windowEnd = new Date(preferredDate.getTime() + 4 * 60 * 60 * 1000);

	const availability = await calendarProvider.getAvailability({
		start: windowStart.toISOString(),
		end: windowEnd.toISOString(),
	});

	const freeWindows = availability.filter((w) => w.status === "free");
	const slots: TimeSlot[] = [];

	for (const window of freeWindows) {
		const windowStartMs = new Date(window.start).getTime();
		const windowEndMs = new Date(window.end).getTime();
		const durationMs = durationMinutes * 60 * 1000;

		if (windowEndMs - windowStartMs >= durationMs) {
			const slotStart = new Date(Math.max(windowStartMs, preferredDate.getTime() - durationMs));
			const adjustedStart = new Date(Math.max(slotStart.getTime(), windowStartMs));
			const adjustedEnd = new Date(adjustedStart.getTime() + durationMs);

			if (adjustedEnd.getTime() <= windowEndMs) {
				slots.push({
					start: adjustedStart.toISOString(),
					end: adjustedEnd.toISOString(),
				});
			}
		}
	}

	if (slots.length === 0) {
		const end = new Date(preferredDate.getTime() + durationMinutes * 60 * 1000);
		slots.push({ start: preferredDate.toISOString(), end: end.toISOString() });
	}

	slots.sort((a, b) => {
		const aDist = Math.abs(new Date(a.start).getTime() - preferredDate.getTime());
		const bDist = Math.abs(new Date(b.start).getTime() - preferredDate.getTime());
		return aDist - bDist;
	});

	return slots;
}
