import {
	type SchedulingProposal,
	type TimeSlot,
	ValidationError,
	generateSchedulingId,
	validateSchedulingProposal,
} from "trusted-agents-core";
import { resolveConfiguredCalendarProvider } from "../lib/calendar/setup.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success, verbose } from "../lib/output.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

export interface RequestMeetingOptions {
	title: string;
	duration?: string;
	preferred?: string;
	location?: string;
	note?: string;
	dryRun?: boolean;
}

/**
 * `tap message request-meeting` — propose a meeting to a connected peer. The
 * CLI builds the slot list locally (using the configured calendar provider
 * when available) and posts the proposal to tapd, which sends the action.
 */
export async function messageRequestMeetingCommand(
	peer: string,
	cmdOpts: RequestMeetingOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		if (!cmdOpts.title) {
			throw new ValidationError("--title is required");
		}

		const config = await loadConfig(opts);
		const durationMinutes = Number.parseInt(cmdOpts.duration ?? "60", 10);
		if (Number.isNaN(durationMinutes) || durationMinutes <= 0) {
			throw new ValidationError("--duration must be a positive number of minutes");
		}

		const schedulingId = generateSchedulingId();
		const slots = await buildSlots(config.dataDir, cmdOpts.preferred, durationMinutes);
		const originTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

		const proposal: SchedulingProposal = {
			type: "scheduling/propose",
			schedulingId,
			title: cmdOpts.title,
			duration: durationMinutes,
			slots,
			originTimezone,
			...(cmdOpts.location ? { location: cmdOpts.location } : {}),
			...(cmdOpts.note ? { note: cmdOpts.note } : {}),
		};

		validateSchedulingProposal(proposal);

		if (cmdOpts.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					peer,
					scheduling_id: schedulingId,
					title: proposal.title,
					duration: proposal.duration,
					slot_count: proposal.slots.length,
					slots: proposal.slots,
					scope: "scheduling/request",
					origin_timezone: proposal.originTimezone,
					...(proposal.location ? { location: proposal.location } : {}),
					...(proposal.note ? { note: proposal.note } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		verbose(`Requesting meeting with ${peer}: "${cmdOpts.title}"...`, opts);

		const client = await TapdClient.forDataDir(config.dataDir);
		const result = await client.requestMeeting({ peer, proposal });

		success(
			{
				requested: true,
				peer: result.peerName,
				agent_id: result.peerAgentId,
				scheduling_id: result.schedulingId,
				title: result.title,
				duration: result.duration,
				slot_count: result.slotCount,
				scope: "scheduling/request",
				receipt: result.receipt,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

async function buildSlots(
	dataDir: string,
	preferred: string | undefined,
	durationMinutes: number,
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

	const calendarProvider = resolveConfiguredCalendarProvider(dataDir);
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
