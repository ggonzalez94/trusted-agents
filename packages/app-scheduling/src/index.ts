import { defineTapApp } from "trusted-agents-core";
import { handleSchedulingRequest } from "./handler.js";

export { handleSchedulingRequest } from "./handler.js";
export {
	parseSchedulingActionRequest,
	parseSchedulingActionResponse,
	buildSchedulingProposalText,
	buildSchedulingAcceptText,
	buildSchedulingRejectText,
} from "trusted-agents-core";
export {
	findApplicableSchedulingGrants,
	matchesSchedulingConstraints,
	filterSchedulingProposalSlots,
	findSchedulableSchedulingSlots,
} from "trusted-agents-core";
export { SchedulingHandler } from "./scheduling-handler.js";
export type {
	SchedulingApprovalContext,
	ProposedMeeting,
	ConfirmedMeeting,
	SchedulingHooks,
	SchedulingDecision,
} from "./scheduling-handler.js";
export type {
	TimeSlot,
	SchedulingProposal,
	SchedulingAccept,
	SchedulingReject,
	SchedulingPayload,
} from "trusted-agents-core";
export {
	generateSchedulingId,
	validateTimeSlot,
	validateSchedulingProposal,
	validateSchedulingAccept,
	validateSchedulingReject,
} from "trusted-agents-core";
export type { AvailabilityWindow, CalendarEvent, ICalendarProvider } from "trusted-agents-core";

export function buildSchedulingPayload(params: {
	title: string;
	durationMinutes: number;
	proposedSlots: Array<{ start: string; end: string }>;
	timezone?: string;
	schedulingId?: string;
	note?: string;
}): Record<string, unknown> {
	return {
		type: "scheduling/propose",
		schedulingId:
			params.schedulingId ?? `sch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
		title: params.title,
		duration: params.durationMinutes,
		slots: params.proposedSlots,
		originTimezone: params.timezone ?? "UTC",
		...(params.note ? { note: params.note } : {}),
	};
}

export const schedulingApp = defineTapApp({
	id: "scheduling",
	name: "Scheduling",
	version: "1.0.0",
	actions: {
		"scheduling/propose": { handler: handleSchedulingRequest },
		"scheduling/counter": { handler: handleSchedulingRequest },
	},
	grantScopes: ["scheduling/request"],
});

export default schedulingApp;
