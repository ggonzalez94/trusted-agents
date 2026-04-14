import type {
	SchedulingProposal,
	TapCancelMeetingResult,
	TapMessagingService,
	TapRequestMeetingResult,
	TapSyncReport,
} from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

interface RequestMeetingBody {
	peer: string;
	proposal: SchedulingProposal;
}

function isRequestMeetingBody(value: unknown): value is RequestMeetingBody {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
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

interface RespondBody {
	approve: boolean;
	reason?: string;
}

function isRespondBody(value: unknown): value is RespondBody {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
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

/**
 * Routes that wrap the scheduling/meeting flows on `TapMessagingService`.
 */
export function createMeetingsRoutes(service: TapMessagingService): MeetingsRoutes {
	return {
		request: async (_params, body) => {
			if (!isRequestMeetingBody(body)) {
				throw new Error("meetings POST requires { peer: string, proposal: SchedulingProposal }");
			}
			return await service.requestMeeting(body);
		},

		respond: async (params, body) => {
			const schedulingId = params.id;
			if (!schedulingId) {
				throw new Error("missing schedulingId");
			}
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
			const schedulingId = params.id;
			if (!schedulingId) {
				throw new Error("missing schedulingId");
			}
			if (!isCancelBody(body)) {
				throw new Error("cancel body must be { reason?: string } or empty");
			}
			return await service.cancelMeeting(schedulingId, body?.reason);
		},
	};
}
