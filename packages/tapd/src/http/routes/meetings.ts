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
import type { RouteHandler } from "../router.js";
import { asRecord, requireParam } from "../validation.js";

/**
 * Full-shape body. Back-compat for the CLI `tap message request-meeting`
 * command, which still builds the proposal client-side and posts it here.
 */
interface RequestMeetingFullBody {
	peer: string;
	proposal: SchedulingProposal;
}

/**
 * Flat-shape body. Used by Hermes Python plugin and OpenClaw TS plugin —
 * they don't have direct access to `generateSchedulingId` or a calendar
 * provider, so tapd builds the full `SchedulingProposal` centrally. Either
 * a caller-supplied `slots` array OR a `preferred` ISO timestamp can be
 * used; if neither is present we default to a placeholder slot ~24h ahead.
 */
interface RequestMeetingFlatBody {
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

function isFullShape(value: Record<string, unknown>): boolean {
	return typeof value.proposal === "object" && value.proposal !== null;
}

function isRequestMeetingFullBody(value: unknown): value is RequestMeetingFullBody {
	const v = asRecord(value);
	if (!v) return false;
	if (typeof v.peer !== "string" || v.peer.length === 0) return false;
	if (!v.proposal || typeof v.proposal !== "object") return false;
	const p = v.proposal as Record<string, unknown>;
	if (p.type !== "scheduling/propose") return false;
	if (typeof p.schedulingId !== "string") return false;
	if (typeof p.title !== "string") return false;
	if (typeof p.duration !== "number") return false;
	if (!Array.isArray(p.slots)) return false;
	return true;
}

function isRequestMeetingFlatBody(value: unknown): value is RequestMeetingFlatBody {
	const v = asRecord(value);
	if (!v) return false;
	if (typeof v.peer !== "string" || v.peer.length === 0) return false;
	if (typeof v.title !== "string" || v.title.trim().length === 0) return false;
	if (typeof v.duration !== "number" || !Number.isFinite(v.duration) || v.duration <= 0) {
		return false;
	}
	if (v.slots !== undefined && !Array.isArray(v.slots)) return false;
	if (v.preferred !== undefined && typeof v.preferred !== "string") return false;
	if (v.location !== undefined && typeof v.location !== "string") return false;
	if (v.note !== undefined && typeof v.note !== "string") return false;
	if (v.schedulingId !== undefined && typeof v.schedulingId !== "string") return false;
	if (v.originTimezone !== undefined && typeof v.originTimezone !== "string") return false;
	return true;
}

interface RespondBody {
	approve: boolean;
	reason?: string;
}

function isRespondBody(value: unknown): value is RespondBody {
	const v = asRecord(value);
	if (!v) return false;
	if (typeof v.approve !== "boolean") return false;
	if (v.reason !== undefined && typeof v.reason !== "string") return false;
	return true;
}

interface CancelBody {
	reason?: string;
}

function isCancelBody(value: unknown): value is CancelBody {
	if (value === undefined || value === null) return true;
	if (typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.reason !== undefined && typeof v.reason !== "string") return false;
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
 * The `request` handler accepts two body shapes:
 *
 *   1. `{ peer, proposal: SchedulingProposal }` — the full shape the CLI
 *      already uses. Back-compat, unchanged.
 *   2. `{ peer, title, duration, preferred?, slots?, location?, note?,
 *         schedulingId?, originTimezone? }` — a flat shape that lets host
 *      plugins (Hermes Python, OpenClaw TS) post a meeting without having
 *      to generate a schedulingId, build slots, or know about
 *      `type: "scheduling/propose"`. tapd constructs the full proposal,
 *      validates it, and forwards to `service.requestMeeting`.
 */
export function createMeetingsRoutes(
	service: TapMessagingService,
	options: MeetingsRoutesOptions = {},
): MeetingsRoutes {
	const calendarProvider = options.calendarProvider ?? null;

	return {
		request: async (_params, body) => {
			const raw = asRecord(body);
			if (!raw) {
				throw new Error(
					"meetings POST requires { peer, proposal } or { peer, title, duration, ... }",
				);
			}

			if (isFullShape(raw)) {
				if (!isRequestMeetingFullBody(body)) {
					throw new Error(
						"meetings POST with a full body requires { peer: string, proposal: SchedulingProposal }",
					);
				}
				return await service.requestMeeting(body);
			}

			if (!isRequestMeetingFlatBody(body)) {
				throw new Error(
					"meetings POST flat body requires { peer: string, title: string, duration: number, ... }",
				);
			}

			const proposal = await buildProposalFromFlat(body, calendarProvider);
			validateSchedulingProposal(proposal);
			return await service.requestMeeting({ peer: body.peer, proposal });
		},

		respond: async (params, body) => {
			const schedulingId = requireParam(params, "id");
			if (!isRespondBody(body)) {
				throw new Error("respond requires { approve: boolean, reason?: string }");
			}
			const pending = await service.listPendingRequests();
			const match = pending.find((entry) => {
				if (entry.direction !== "inbound") return false;
				const details = entry.details as { type?: string; schedulingId?: string } | undefined;
				return details?.type === "scheduling" && details.schedulingId === schedulingId;
			});
			if (!match) {
				throw new Error(`No pending scheduling request found with schedulingId: ${schedulingId}`);
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
			if (!isCancelBody(body)) {
				throw new Error("cancel body must be { reason?: string } or empty");
			}
			return await service.cancelMeeting(schedulingId, body?.reason);
		},
	};
}

async function buildProposalFromFlat(
	body: RequestMeetingFlatBody,
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
