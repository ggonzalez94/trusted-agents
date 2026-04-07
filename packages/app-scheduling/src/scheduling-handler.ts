import type {
	Contact,
	ICalendarProvider,
	SchedulingAccept,
	SchedulingDecision,
	SchedulingHooks,
	SchedulingProposal,
} from "trusted-agents-core";
import {
	buildCounterSlots,
	findApplicableSchedulingGrants,
	findOverlappingFreeSlots,
	findSchedulableSchedulingSlots,
	getProposalTimeRange,
} from "trusted-agents-core";

export type {
	SchedulingApprovalContext,
	ConfirmedMeeting,
	ProposedMeeting,
	SchedulingDecision,
	SchedulingHooks,
} from "trusted-agents-core";

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
		const schedulableProposalSlots = hasGrants
			? findSchedulableSchedulingSlots(activeSchedulingGrants, proposal)
			: proposal.slots;

		if (schedulableProposalSlots.length === 0) {
			return { action: "reject", reason: "No proposed time slots match grant constraints" };
		}

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

		const timeRange = getProposalTimeRange(schedulableProposalSlots);
		const availability = await this.calendarProvider.getAvailability(timeRange);

		const overlapping = findOverlappingFreeSlots(schedulableProposalSlots, availability);
		const bestSlot = overlapping[0];
		if (bestSlot !== undefined) {
			return { action: "confirm", slot: bestSlot, proposal };
		}

		// No overlap — offer own free slots as counter.
		let freeSlots = buildCounterSlots(availability, proposal.duration);
		if (hasGrants) {
			freeSlots = findSchedulableSchedulingSlots(activeSchedulingGrants, {
				...proposal,
				slots: freeSlots,
			});
		}

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
