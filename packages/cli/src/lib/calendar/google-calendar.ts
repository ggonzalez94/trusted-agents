import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AvailabilityWindow, CalendarEvent, ICalendarProvider } from "trusted-agents-core";

const execFileAsync = promisify(execFile);

interface GwsEventItem {
	start?: { dateTime?: string; date?: string };
	end?: { dateTime?: string; date?: string };
	summary?: string;
}

interface GwsEventsResponse {
	items?: GwsEventItem[];
}

interface GwsInsertResponse {
	id?: string;
}

export class GoogleCalendarCliProvider implements ICalendarProvider {
	protected readonly gwsCommand: string;

	constructor(options?: { gwsCommand?: string }) {
		this.gwsCommand = options?.gwsCommand ?? "gws";
	}

	protected async runGws(args: string[]): Promise<{ stdout: string; stderr: string }> {
		try {
			return await execFileAsync(this.gwsCommand, args, {
				timeout: 30_000,
			});
		} catch (err: unknown) {
			if (
				err !== null &&
				typeof err === "object" &&
				"code" in err &&
				(err as { code?: string }).code === "ENOENT"
			) {
				throw new Error(
					"gws CLI not found. Install it from https://github.com/nicholasgasior/gws and ensure it is on your PATH.",
				);
			}
			throw err;
		}
	}

	async getAvailability(
		timeRange: { start: string; end: string },
		options?: { timezone?: string },
	): Promise<AvailabilityWindow[]> {
		const params: Record<string, string> = {
			timeMin: timeRange.start,
			timeMax: timeRange.end,
			singleEvents: "true",
			orderBy: "startTime",
		};

		if (options?.timezone) {
			params.timeZone = options.timezone;
		}

		const { stdout } = await this.runGws([
			"calendar",
			"events",
			"list",
			"--params",
			JSON.stringify(params),
		]);

		const response = JSON.parse(stdout) as GwsEventsResponse;
		const events = response.items ?? [];

		return invertToAvailability(events, timeRange.start, timeRange.end);
	}

	async createEvent(event: CalendarEvent): Promise<{ eventId: string }> {
		const args: string[] = ["calendar", "+insert"];
		args.push("--summary", event.title);
		args.push("--start", event.start);
		args.push("--end", event.end);
		if (event.location) {
			args.push("--location", event.location);
		}
		if (event.description) {
			args.push("--description", event.description);
		}
		if (event.timezone) {
			args.push("--timezone", event.timezone);
		}

		const { stdout } = await this.runGws(args);
		const response = JSON.parse(stdout) as GwsInsertResponse;
		const eventId = response.id;
		if (!eventId) {
			throw new Error("Failed to extract event ID from gws response");
		}
		return { eventId };
	}

	async cancelEvent(eventId: string): Promise<void> {
		await this.runGws(["calendar", "events", "delete", "--params", JSON.stringify({ eventId })]);
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function eventDateTime(dt: GwsEventItem["start"]): string | null {
	if (!dt) return null;
	return dt.dateTime ?? dt.date ?? null;
}

export function invertToAvailability(
	events: GwsEventItem[],
	rangeStart: string,
	rangeEnd: string,
): AvailabilityWindow[] {
	const sortedEvents = events
		.map((e) => ({
			start: eventDateTime(e.start),
			end: eventDateTime(e.end),
		}))
		.filter((e): e is { start: string; end: string } => e.start !== null && e.end !== null)
		.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

	const windows: AvailabilityWindow[] = [];
	let cursor = rangeStart;

	for (const event of sortedEvents) {
		const eventStart = event.start;
		const eventEnd = event.end;

		if (new Date(eventStart) > new Date(cursor)) {
			windows.push({ start: cursor, end: eventStart, status: "free" });
		}

		windows.push({ start: eventStart, end: eventEnd, status: "busy" });

		if (new Date(eventEnd) > new Date(cursor)) {
			cursor = eventEnd;
		}
	}

	if (new Date(cursor) < new Date(rangeEnd)) {
		windows.push({ start: cursor, end: rangeEnd, status: "free" });
	}

	return windows;
}
