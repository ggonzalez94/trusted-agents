import { readCalendarProvider, resolveConfiguredCalendarProvider } from "../lib/calendar/setup.js";
import { resolveDataDir } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { info, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function calendarCheckCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const dataDir = resolveDataDir(opts);
		const provider = readCalendarProvider(dataDir);

		if (!provider) {
			info("No calendar provider configured. Run 'tap calendar setup' first.", opts);
			success({ configured: false }, opts, startTime);
			return;
		}

		info(`Calendar provider: ${provider}`, opts);
		info("Checking availability for the next 24 hours...", opts);

		const calendarProvider = resolveConfiguredCalendarProvider(dataDir);
		if (!calendarProvider) {
			throw new Error(`Calendar provider ${provider} is not configured`);
		}
		const now = new Date();
		const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
		const windows = await calendarProvider.getAvailability({
			start: now.toISOString(),
			end: tomorrow.toISOString(),
		});

		const freeWindows = windows.filter((w) => w.status === "free");
		const busyWindows = windows.filter((w) => w.status === "busy");

		success(
			{
				configured: true,
				provider,
				next_24h: {
					free_slots: freeWindows.length,
					busy_slots: busyWindows.length,
					windows,
				},
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
