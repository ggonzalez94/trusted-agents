import { describe, expect, it, vi } from "vitest";
import type { ICalendarProvider } from "../../src/index.js";
import { buildSchedulingSlots } from "../../src/index.js";

function makeCalendar(
	availability: Array<{ start: string; end: string; status: "free" | "busy" }>,
): ICalendarProvider {
	return {
		getAvailability: vi.fn(async () => availability),
		createEvent: vi.fn(async () => ({ eventId: "unused" })),
		cancelEvent: vi.fn(async () => {}),
	};
}

describe("buildSchedulingSlots", () => {
	it("returns a single placeholder slot ~24h ahead when no preferred time and no calendar", async () => {
		const before = Date.now();
		const slots = await buildSchedulingSlots(undefined, 30, null);
		const after = Date.now();

		expect(slots).toHaveLength(1);
		const startMs = new Date(slots[0].start).getTime();
		const endMs = new Date(slots[0].end).getTime();

		// ~24h ahead (+/- a few seconds for test latency)
		expect(startMs).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 100);
		expect(startMs).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 100);
		expect(endMs - startMs).toBe(30 * 60 * 1000);
	});

	it("returns a single slot anchored at preferred time when calendar is null", async () => {
		const preferred = "2026-05-01T15:00:00.000Z";
		const slots = await buildSchedulingSlots(preferred, 45, null);

		expect(slots).toHaveLength(1);
		expect(slots[0].start).toBe(preferred);
		expect(new Date(slots[0].end).getTime() - new Date(slots[0].start).getTime()).toBe(
			45 * 60 * 1000,
		);
	});

	it("throws on invalid preferred ISO string", async () => {
		await expect(buildSchedulingSlots("not a date", 30, null)).rejects.toThrow(
			/Invalid preferred time/,
		);
	});

	it("returns slots from free windows sorted by proximity to preferred when calendar has free time", async () => {
		const preferred = "2026-05-01T15:00:00.000Z";
		const calendar = makeCalendar([
			// Free window exactly at preferred
			{
				start: "2026-05-01T14:30:00.000Z",
				end: "2026-05-01T16:30:00.000Z",
				status: "free",
			},
		]);

		const slots = await buildSchedulingSlots(preferred, 30, calendar);

		expect(slots.length).toBeGreaterThanOrEqual(1);
		// First slot should be close to preferred time
		const first = new Date(slots[0].start).getTime();
		expect(Math.abs(first - new Date(preferred).getTime())).toBeLessThanOrEqual(60 * 60 * 1000);
	});

	it("falls back to placeholder slot when the calendar window is fully busy", async () => {
		const preferred = "2026-05-01T15:00:00.000Z";
		const calendar = makeCalendar([
			{
				start: "2026-05-01T13:00:00.000Z",
				end: "2026-05-01T19:00:00.000Z",
				status: "busy",
			},
		]);

		const slots = await buildSchedulingSlots(preferred, 30, calendar);

		expect(slots).toHaveLength(1);
		expect(slots[0].start).toBe(preferred);
	});
});
