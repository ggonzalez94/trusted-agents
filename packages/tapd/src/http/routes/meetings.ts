import {
	type ICalendarProvider,
	type SchedulingProposal,
	type TapCancelMeetingResult,
	type TapMessagingService,
	type TapRequestMeetingResult,
	type TapSyncReport,
	type TimeSlot,
	buildSchedulingSlots,
	generateSchedulingId,
	validateSchedulingProposal,
} from "trusted-agents-core";
import { HttpError } from "../errors.js";
import type { RouteHandler } from "../router.js";
import {
	asRecord,
	hasOptionalStringFields,
	hasPeerField,
	isBoolean,
	isNonBlankString,
	isOptionalArray,
	isOptionalReasonBody,
	isPositiveFiniteNumber,
	requireBody,
	requireParam,
} from "../validation.js";

/**
 * Flat body shared by every meetings client (CLI, Hermes Python plugin,
 * OpenClaw TS plugin). Tapd generates the schedulingId default when the
 * caller omits one and either honors a caller-supplied `slots` array or
 * builds slots from `preferred` (or a placeholder ~24h ahead when neither
 * is present). Standardising on this single shape eliminates the per-host
 * drift the dual-shape route used to invite.
 */
interface RequestMeetingBody {
	peer: string;
	title: string;
	duration: number;
	slots?: TimeSlot[];
	preferred?: string;
	location?: string;
	note?: string;
	schedulingId?: string;
	originTimezone?: string;
}

function isRequestMeetingBody(value: unknown): value is RequestMeetingBody {
	const v = asRecord(value);
	if (!v) return false;
	if (!hasPeerField(v)) return false;
	if (!isNonBlankString(v.title)) return false;
	if (!isPositiveFiniteNumber(v.duration)) return false;
	if (!isOptionalArray(v.slots)) return false;
	if (
		!hasOptionalStringFields(v, ["preferred", "location", "note", "schedulingId", "originTimezone"])
	) {
		return false;
	}
	return true;
}

interface RespondBody {
	approve: boolean;
	reason?: string;
}

function isRespondBody(value: unknown): value is RespondBody {
	const v = asRecord(value);
	if (!v) return false;
	if (!isBoolean(v.approve)) return false;
	if (!hasOptionalStringFields(v, ["reason"])) return false;
	return true;
}

export interface MeetingRespondResult {
	resolved: true;
	schedulingId: string;
	requestId: string;
	approve: boolean;
	report: TapSyncReport;
}

export interface MeetingsRoutes {
	request: RouteHandler<unknown, TapRequestMeetingResult>;
	respond: RouteHandler<unknown, MeetingRespondResult>;
	cancel: RouteHandler<unknown, TapCancelMeetingResult>;
}

export interface MeetingsRoutesOptions {
	/**
	 * Calendar provider used to build slots when the flat-shape body
	 * omits `slots` but supplies `preferred`. May be null (tapd's default)
	 * — in that case we use the preferred time directly as a single slot,
	 * or fall back to a placeholder slot ~24h ahead when nothing is
	 * supplied. See `buildSchedulingSlots` for the exact semantics.
	 */
	calendarProvider?: ICalendarProvider | null;
}

/**
 * Routes that wrap the scheduling/meeting flows on `TapMessagingService`.
 *
 * The `request` handler accepts a single flat body shape:
 *
 *   `{ peer, title, duration, preferred?, slots?, location?, note?,
 *      schedulingId?, originTimezone? }`
 *
 * Tapd generates the schedulingId default when omitted, builds slots from
 * `preferred` (or a placeholder ~24h ahead when neither `slots` nor
 * `preferred` is present), validates the resulting proposal, and forwards
 * to `service.requestMeeting`. CLI and host plugins all send this shape.
 */
export function createMeetingsRoutes(
	service: TapMessagingService,
	options: MeetingsRoutesOptions = {},
): MeetingsRoutes {
	const calendarProvider = options.calendarProvider ?? null;

	return {
		request: async (_params, body) => {
			requireBody(
				body,
				isRequestMeetingBody,
				"meetings POST requires { peer: string, title: string, duration: number, ... }",
			);

			const proposal = await buildProposalFromFlat(body, calendarProvider);
			validateSchedulingProposal(proposal);
			return await service.requestMeeting({ peer: body.peer, proposal });
		},

		respond: async (params, body) => {
			const schedulingId = requireParam(params, "id");
			requireBody(body, isRespondBody, "respond requires { approve: boolean, reason?: string }");
			const pending = await service.listPendingRequests();
			const match = pending.find((entry) => {
				if (entry.direction !== "inbound") return false;
				const details = entry.details as { type?: string; schedulingId?: string } | undefined;
				return details?.type === "scheduling" && details.schedulingId === schedulingId;
			});
			if (!match) {
				throw new HttpError(
					404,
					"scheduling_not_found",
					`No pending scheduling request found with schedulingId: ${schedulingId}`,
				);
			}
			const report = await service.resolvePending(match.requestId, body.approve, body.reason);
			return {
				resolved: true,
				schedulingId,
				requestId: match.requestId,
				approve: body.approve,
				report,
			};
		},

		cancel: async (params, body) => {
			const schedulingId = requireParam(params, "id");
			requireBody(body, isOptionalReasonBody, "cancel body must be { reason?: string } or empty");
			return await service.cancelMeeting(schedulingId, body?.reason);
		},
	};
}

async function buildProposalFromFlat(
	body: RequestMeetingBody,
	calendarProvider: ICalendarProvider | null,
): Promise<SchedulingProposal> {
	const schedulingId = body.schedulingId ?? generateSchedulingId();

	const slots: TimeSlot[] =
		body.slots && body.slots.length > 0
			? body.slots
			: await buildSchedulingSlots(body.preferred, body.duration, calendarProvider);

	const originTimezone =
		body.originTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

	const proposal: SchedulingProposal = {
		type: "scheduling/propose",
		schedulingId,
		title: body.title,
		duration: body.duration,
		slots,
		originTimezone,
		...(body.location ? { location: body.location } : {}),
		...(body.note ? { note: body.note } : {}),
	};

	return proposal;
}
