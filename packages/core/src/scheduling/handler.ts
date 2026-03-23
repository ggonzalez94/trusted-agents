import type { PermissionGrant } from "../permissions/types.js";
import type { Contact } from "../trust/types.js";
import type { AvailabilityWindow, ICalendarProvider } from "./calendar-provider.js";
import { findApplicableSchedulingGrants } from "./grants.js";
import type { SchedulingAccept, SchedulingProposal, TimeSlot } from "./types.js";

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface SchedulingApprovalContext {
	requestId: string;
	contact: Contact;
	proposal: SchedulingProposal;
	activeSchedulingGrants: PermissionGrant[];
}

export interface ProposedMeeting {
	schedulingId: string;
	title: string;
	slot: TimeSlot;
	peerName: string;
	peerAgentId: number;
	originTimezone: string;
}

export interface ConfirmedMeeting extends ProposedMeeting {
	eventId?: string;
}

export interface SchedulingHooks {
	approveScheduling?: (context: SchedulingApprovalContext) => Promise<boolean | null>;
	confirmMeeting?: (meeting: ProposedMeeting) => Promise<boolean>;
	onMeetingConfirmed?: (meeting: ConfirmedMeeting) => Promise<void>;
	log?: (level: "info" | "warn" | "error", message: string) => void;
}

export type SchedulingDecision =
	| { action: "confirm"; slot: TimeSlot; proposal: SchedulingProposal }
	| { action: "counter"; slots: TimeSlot[]; proposal: SchedulingProposal }
	| { action: "reject"; reason: string }
	| { action: "defer" };

// ── Internal helpers ──────────────────────────────────────────────────────────

function getProposalTimeRange(slots: TimeSlot[]): { start: string; end: string } {
	let minStart = slots[0]?.start ?? "";
	let maxEnd = slots[0]?.end ?? "";
	for (const slot of slots) {
		if (slot.start < minStart) minStart = slot.start;
		if (slot.end > maxEnd) maxEnd = slot.end;
	}
	return { start: minStart, end: maxEnd };
}

function findOverlappingFreeSlots(
	proposedSlots: TimeSlot[],
	availability: AvailabilityWindow[],
): TimeSlot[] {
	const freeWindows = availability.filter((w) => w.status === "free");
	return proposedSlots.filter((slot) =>
		freeWindows.some(
			(window) =>
				new Date(slot.start) >= new Date(window.start) &&
				new Date(slot.end) <= new Date(window.end),
		),
	);
}

// ── SchedulingHandler ─────────────────────────────────────────────────────────

export class SchedulingHandler {
	private readonly calendarProvider: ICalendarProvider | undefined;
	private readonly hooks: SchedulingHooks;

	constructor(options: { calendarProvider?: ICalendarProvider; hooks: SchedulingHooks }) {
		this.calendarProvider = options.calendarProvider;
		this.hooks = options.hooks;
	}

	async evaluateProposal(
		requestId: string,
		contact: Contact,
		proposal: SchedulingProposal,
	): Promise<SchedulingDecision> {
		const activeSchedulingGrants = findApplicableSchedulingGrants(
			contact.permissions.grantedByMe,
			proposal,
		);

		const hasGrants = activeSchedulingGrants.length > 0;

		if (!hasGrants) {
			if (this.hooks.approveScheduling) {
				const approved = await this.hooks.approveScheduling({
					requestId,
					contact,
					proposal,
					activeSchedulingGrants,
				});
				if (approved === false) {
					return { action: "reject", reason: "Scheduling request declined" };
				}
				if (approved === null) {
					return { action: "defer" };
				}
				// approved === true: fall through to calendar check
			} else {
				return { action: "reject", reason: "No matching scheduling grant" };
			}
		}

		// At this point grants exist or hook approved — check calendar
		if (!this.calendarProvider) {
			return { action: "defer" };
		}

		const timeRange = getProposalTimeRange(proposal.slots);
		const availability = await this.calendarProvider.getAvailability(timeRange);

		const overlapping = findOverlappingFreeSlots(proposal.slots, availability);
		const bestSlot = overlapping[0];
		if (bestSlot !== undefined) {
			return { action: "confirm", slot: bestSlot, proposal };
		}

		// No overlap — offer own free slots as counter
		const freeSlots = availability
			.filter((w) => w.status === "free")
			.map((w): TimeSlot => ({ start: w.start, end: w.end }));

		if (freeSlots.length > 0) {
			return { action: "counter", slots: freeSlots, proposal };
		}

		return { action: "reject", reason: "No available time slots" };
	}

	async handleAccept(
		accept: SchedulingAccept,
		_peerName: string,
		title: string,
		originTimezone: string,
	): Promise<{ eventId?: string }> {
		if (!this.calendarProvider) {
			return {};
		}

		const result = await this.calendarProvider.createEvent({
			title,
			start: accept.acceptedSlot.start,
			end: accept.acceptedSlot.end,
			timezone: originTimezone,
		});

		return { eventId: result.eventId };
	}

	async handleCancel(eventId: string): Promise<void> {
		if (!this.calendarProvider) {
			return;
		}
		await this.calendarProvider.cancelEvent(eventId);
	}
}
