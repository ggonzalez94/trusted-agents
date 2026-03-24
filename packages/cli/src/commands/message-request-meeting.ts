import {
	type SchedulingProposal,
	type TimeSlot,
	ValidationError,
	generateSchedulingId,
	validateSchedulingProposal,
} from "trusted-agents-core";
import { resolveConfiguredCalendarProvider } from "../lib/calendar/setup.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import {
	isQueuedTapCommandPending,
	queuedTapCommandPendingFields,
	queuedTapCommandResultFields,
	runOrQueueTapCommand,
} from "../lib/queued-commands.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
import type { GlobalOptions } from "../types.js";

export interface RequestMeetingOptions {
	title: string;
	duration?: string;
	preferred?: string;
	location?: string;
	note?: string;
}

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
		const ctx = buildContextWithTransport(config);
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

		verbose(`Requesting meeting with ${peer}: "${cmdOpts.title}"...`, opts);

		const service = createCliTapMessagingService(ctx, opts, {
			ownerLabel: "tap:request-meeting",
		});

		const outcome = await runOrQueueTapCommand(
			config.dataDir,
			{
				type: "request-meeting",
				payload: {
					input: { peer, proposal },
				},
			},
			async () => await service.requestMeeting({ peer, proposal }),
			{
				requestedBy: "tap:request-meeting",
			},
		);

		if (isQueuedTapCommandPending(outcome)) {
			success(
				{
					...queuedTapCommandPendingFields(outcome),
					peer,
					scheduling_id: schedulingId,
					title: cmdOpts.title,
					scope: "scheduling/request",
				},
				opts,
				startTime,
			);
			return;
		}

		const result = outcome.result;

		success(
			{
				requested: true,
				...queuedTapCommandResultFields(outcome),
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
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

async function buildSlots(
	dataDir: string,
	preferred: string | undefined,
	durationMinutes: number,
): Promise<TimeSlot[]> {
	if (!preferred) {
		// Default: offer a slot 24h from now
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
		// No calendar: single slot at preferred time
		const end = new Date(preferredDate.getTime() + durationMinutes * 60 * 1000);
		return [{ start: preferredDate.toISOString(), end: end.toISOString() }];
	}

	// With calendar: check availability around preferred time and build ranked slots
	const windowStart = new Date(preferredDate.getTime() - 2 * 60 * 60 * 1000); // 2h before
	const windowEnd = new Date(preferredDate.getTime() + 4 * 60 * 60 * 1000); // 4h after

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
			// Offer a slot at the start of this free window
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
		// No free slots found, fall back to preferred time
		const end = new Date(preferredDate.getTime() + durationMinutes * 60 * 1000);
		slots.push({ start: preferredDate.toISOString(), end: end.toISOString() });
	}

	// Rank: preferred time first (or closest to it)
	slots.sort((a, b) => {
		const aDist = Math.abs(new Date(a.start).getTime() - preferredDate.getTime());
		const bDist = Math.abs(new Date(b.start).getTime() - preferredDate.getTime());
		return aDist - bDist;
	});

	return slots;
}
