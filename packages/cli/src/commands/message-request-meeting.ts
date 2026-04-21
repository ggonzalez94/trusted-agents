import { ValidationError, buildSchedulingSlots, generateSchedulingId } from "trusted-agents-core";
import { resolveConfiguredCalendarProvider } from "../lib/calendar/setup.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success, verbose } from "../lib/output.js";
import { type RequestMeetingBody, TapdClient } from "../lib/tapd-client.js";
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

		// CLI builds the slot list locally (with the configured calendar
		// provider) and sends the result over the flat /api/meetings shape;
		// tapd fills in the schedulingId default if we omit it and validates
		// the resulting proposal. We pre-generate the id here so dry-run can
		// echo it back to the operator.
		const schedulingId = generateSchedulingId();
		const calendarProvider = resolveConfiguredCalendarProvider(config.dataDir) ?? null;
		const slots = await buildSchedulingSlots(cmdOpts.preferred, durationMinutes, calendarProvider);
		const originTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

		const body: RequestMeetingBody = {
			peer,
			title: cmdOpts.title,
			duration: durationMinutes,
			slots,
			originTimezone,
			schedulingId,
			...(cmdOpts.preferred ? { preferred: cmdOpts.preferred } : {}),
			...(cmdOpts.location ? { location: cmdOpts.location } : {}),
			...(cmdOpts.note ? { note: cmdOpts.note } : {}),
		};

		if (cmdOpts.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					peer,
					scheduling_id: schedulingId,
					title: body.title,
					duration: body.duration,
					slot_count: slots.length,
					slots,
					scope: "scheduling/request",
					origin_timezone: originTimezone,
					...(cmdOpts.location ? { location: cmdOpts.location } : {}),
					...(cmdOpts.note ? { note: cmdOpts.note } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		verbose(`Requesting meeting with ${peer}: "${cmdOpts.title}"...`, opts);

		const client = await TapdClient.forDataDir(config.dataDir);
		const result = await client.requestMeeting(body);

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
