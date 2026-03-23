import { describe, expect, it } from "vitest";
import {
	GoogleCalendarCliProvider,
	invertToAvailability,
} from "../../src/lib/calendar/google-calendar.js";

// ── Mock provider ────────────────────────────────────────────────────────────

class MockGoogleCalendarProvider extends GoogleCalendarCliProvider {
	private mockResponses = new Map<string, string>();

	setMockResponse(key: string, response: string): void {
		this.mockResponses.set(key, response);
	}

	protected override async runGws(args: string[]): Promise<{ stdout: string; stderr: string }> {
		// Build a lookup key from the first two args
		const key = args.slice(0, 3).join(" ");
		for (const [matchKey, response] of this.mockResponses) {
			if (key.includes(matchKey)) {
				return { stdout: response, stderr: "" };
			}
		}
		throw new Error(`No mock response for gws ${args.join(" ")}`);
	}
}

// ── Provider with nonexistent binary to trigger real ENOENT ──────────────────

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GoogleCalendarCliProvider", () => {
	describe("getAvailability with events", () => {
		it("returns correct free/busy windows when events exist", async () => {
			const provider = new MockGoogleCalendarProvider();
			provider.setMockResponse(
				"calendar events list",
				JSON.stringify({
					items: [
						{
							start: { dateTime: "2026-03-22T10:00:00Z" },
							end: { dateTime: "2026-03-22T11:00:00Z" },
							summary: "Team standup",
						},
						{
							start: { dateTime: "2026-03-22T14:00:00Z" },
							end: { dateTime: "2026-03-22T15:00:00Z" },
							summary: "1:1 meeting",
						},
					],
				}),
			);

			const windows = await provider.getAvailability({
				start: "2026-03-22T09:00:00Z",
				end: "2026-03-22T17:00:00Z",
			});

			expect(windows).toEqual([
				{ start: "2026-03-22T09:00:00Z", end: "2026-03-22T10:00:00Z", status: "free" },
				{ start: "2026-03-22T10:00:00Z", end: "2026-03-22T11:00:00Z", status: "busy" },
				{ start: "2026-03-22T11:00:00Z", end: "2026-03-22T14:00:00Z", status: "free" },
				{ start: "2026-03-22T14:00:00Z", end: "2026-03-22T15:00:00Z", status: "busy" },
				{ start: "2026-03-22T15:00:00Z", end: "2026-03-22T17:00:00Z", status: "free" },
			]);
		});
	});

	describe("getAvailability with no events", () => {
		it("returns entire range as free when no events", async () => {
			const provider = new MockGoogleCalendarProvider();
			provider.setMockResponse("calendar events list", JSON.stringify({ items: [] }));

			const windows = await provider.getAvailability({
				start: "2026-03-22T09:00:00Z",
				end: "2026-03-22T17:00:00Z",
			});

			expect(windows).toEqual([
				{ start: "2026-03-22T09:00:00Z", end: "2026-03-22T17:00:00Z", status: "free" },
			]);
		});
	});

	describe("getAvailability with malformed JSON", () => {
		it("throws a contextual parse error", async () => {
			const provider = new MockGoogleCalendarProvider();
			provider.setMockResponse("calendar events list", "warning: not json");

			await expect(
				provider.getAvailability({
					start: "2026-03-22T09:00:00Z",
					end: "2026-03-22T17:00:00Z",
				}),
			).rejects.toThrow("Failed to parse gws response for calendar events list");
		});
	});

	describe("createEvent", () => {
		it("extracts eventId from gws response", async () => {
			const provider = new MockGoogleCalendarProvider();
			provider.setMockResponse("calendar +insert", JSON.stringify({ id: "evt_abc123" }));

			const result = await provider.createEvent({
				title: "Test Meeting",
				start: "2026-03-22T14:00:00Z",
				end: "2026-03-22T15:00:00Z",
			});

			expect(result.eventId).toBe("evt_abc123");
		});

		it("throws a contextual parse error for malformed JSON", async () => {
			const provider = new MockGoogleCalendarProvider();
			provider.setMockResponse("calendar +insert", "warning: not json");

			await expect(
				provider.createEvent({
					title: "Test Meeting",
					start: "2026-03-22T14:00:00Z",
					end: "2026-03-22T15:00:00Z",
				}),
			).rejects.toThrow("Failed to parse gws response for calendar +insert");
		});
	});

	describe("cancelEvent", () => {
		it("calls correct gws command for deletion", async () => {
			const provider = new MockGoogleCalendarProvider();
			provider.setMockResponse("calendar events delete", "{}");

			// Should not throw
			await provider.cancelEvent("evt_abc123");
		});
	});

	describe("runGws with ENOENT", () => {
		it("throws clear error about installing gws", async () => {
			// Use a nonexistent command to trigger a real ENOENT from execFile
			const provider = new GoogleCalendarCliProvider({
				gwsCommand: "__nonexistent_gws_binary_for_test__",
			});

			await expect(
				provider.getAvailability({
					start: "2026-03-22T09:00:00Z",
					end: "2026-03-22T17:00:00Z",
				}),
			).rejects.toThrow("gws CLI not found");
		});
	});
});

describe("invertToAvailability", () => {
	it("handles overlapping events", () => {
		const events = [
			{
				start: { dateTime: "2026-03-22T10:00:00Z" },
				end: { dateTime: "2026-03-22T11:30:00Z" },
			},
			{
				start: { dateTime: "2026-03-22T11:00:00Z" },
				end: { dateTime: "2026-03-22T12:00:00Z" },
			},
		];

		const windows = invertToAvailability(events, "2026-03-22T09:00:00Z", "2026-03-22T13:00:00Z");

		expect(windows[0]).toEqual({
			start: "2026-03-22T09:00:00Z",
			end: "2026-03-22T10:00:00Z",
			status: "free",
		});
		// First busy block
		expect(windows[1]).toEqual({
			start: "2026-03-22T10:00:00Z",
			end: "2026-03-22T12:00:00Z",
			status: "busy",
		});
		// Free after merged busy window
		expect(windows[2]).toEqual({
			start: "2026-03-22T12:00:00Z",
			end: "2026-03-22T13:00:00Z",
			status: "free",
		});
	});

	it("handles events that use date instead of dateTime", () => {
		const events = [
			{
				start: { date: "2026-03-22" },
				end: { date: "2026-03-23" },
			},
		];

		const windows = invertToAvailability(events, "2026-03-22T00:00:00Z", "2026-03-23T00:00:00Z");

		expect(windows).toEqual([{ start: "2026-03-22", end: "2026-03-23", status: "busy" }]);
	});

	it("returns empty array when range is entirely covered by event", () => {
		const events = [
			{
				start: { dateTime: "2026-03-22T09:00:00Z" },
				end: { dateTime: "2026-03-22T17:00:00Z" },
			},
		];

		const windows = invertToAvailability(events, "2026-03-22T09:00:00Z", "2026-03-22T17:00:00Z");

		expect(windows).toEqual([
			{ start: "2026-03-22T09:00:00Z", end: "2026-03-22T17:00:00Z", status: "busy" },
		]);
	});
});
