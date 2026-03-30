import { defineTapApp } from "trusted-agents-core";
import { handleSchedulingRequest } from "./handler.js";

export { handleSchedulingRequest } from "./handler.js";
export {
	parseSchedulingActionRequest,
	parseSchedulingActionResponse,
	buildSchedulingProposalText,
	buildSchedulingAcceptText,
	buildSchedulingRejectText,
} from "./parser.js";
export {
	findApplicableSchedulingGrants,
	matchesSchedulingConstraints,
	filterSchedulingProposalSlots,
	findSchedulableSchedulingSlots,
} from "./grants.js";
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
} from "./types.js";
export {
	generateSchedulingId,
	validateTimeSlot,
	validateSchedulingProposal,
	validateSchedulingAccept,
	validateSchedulingReject,
} from "./types.js";
export type { AvailabilityWindow, CalendarEvent, ICalendarProvider } from "./calendar-provider.js";

export function buildSchedulingPayload(params: {
	title: string;
	durationMinutes: number;
	proposedSlots: Array<{ start: string; end: string }>;
	timezone?: string;
	note?: string;
}): Record<string, unknown> {
	return { type: "scheduling/request", ...params };
}

export const schedulingApp = defineTapApp({
	id: "scheduling",
	name: "Scheduling",
	version: "1.0.0",
	actions: {
		"scheduling/request": { handler: handleSchedulingRequest },
	},
	grantScopes: ["scheduling/request"],
});

export default schedulingApp;
