import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	type AvailabilityWindow,
	type CalendarEvent,
	type ICalendarProvider,
	isObject,
} from "trusted-agents-core";

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

function parseGwsJson<T>(stdout: string, operation: string): T {
	try {
		return JSON.parse(stdout) as T;
	} catch {
		const body = stdout.trim();
		throw new Error(
			`Failed to parse gws response for ${operation}${body ? `: ${body}` : ": <empty response>"}`,
		);
	}
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
			if (isObject(err) && "code" in err && err.code === "ENOENT") {
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

		const response = parseGwsJson<GwsEventsResponse>(stdout, "calendar events list");
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
		const response = parseGwsJson<GwsInsertResponse>(stdout, "calendar +insert");
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
	const rangeStartMs = new Date(rangeStart).getTime();
	const rangeEndMs = new Date(rangeEnd).getTime();
	const sortedEvents = events
		.map((e) => ({
			start: eventDateTime(e.start),
			end: eventDateTime(e.end),
		}))
		.filter((e): e is { start: string; end: string } => e.start !== null && e.end !== null)
		.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

	const clampedBusy = sortedEvents
		.map((event) => {
			const eventStartMs = new Date(event.start).getTime();
			const eventEndMs = new Date(event.end).getTime();
			const startMs = Math.max(eventStartMs, rangeStartMs);
			const endMs = Math.min(eventEndMs, rangeEndMs);
			if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
				return null;
			}
			return {
				startMs,
				endMs,
				start: startMs === eventStartMs ? event.start : rangeStart,
				end: endMs === eventEndMs ? event.end : rangeEnd,
			};
		})
		.filter(
			(interval): interval is { startMs: number; endMs: number; start: string; end: string } =>
				interval !== null,
		);

	const mergedBusy: Array<{ startMs: number; endMs: number; start: string; end: string }> = [];
	for (const interval of clampedBusy) {
		const last = mergedBusy[mergedBusy.length - 1];
		if (!last || interval.startMs > last.endMs) {
			mergedBusy.push({ ...interval });
			continue;
		}
		if (interval.endMs > last.endMs) {
			last.endMs = interval.endMs;
			last.end = interval.end;
		}
	}

	const windows: AvailabilityWindow[] = [];
	let cursorMs = rangeStartMs;
	let cursor = rangeStart;

	for (const event of mergedBusy) {
		if (event.startMs > cursorMs) {
			windows.push({ start: cursor, end: event.start, status: "free" });
		}

		windows.push({ start: event.start, end: event.end, status: "busy" });
		cursorMs = event.endMs;
		cursor = event.end;
	}

	if (cursorMs < rangeEndMs) {
		windows.push({ start: cursor, end: rangeEnd, status: "free" });
	}

	return windows;
}
