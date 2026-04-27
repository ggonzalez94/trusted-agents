import type {
	Contact,
	SchedulingHandler,
	SchedulingProposal,
	TapActionContext,
	TapActionResult,
	TimeSlot,
} from "trusted-agents-core";
import {
	createGrantSet,
	findApplicableSchedulingGrants,
	findSchedulableSchedulingSlots,
	mapSchedulingDecisionToResult,
	parseSchedulingActionPayload,
} from "trusted-agents-core";

export async function handleSchedulingRequest(ctx: TapActionContext): Promise<TapActionResult> {
	const proposal = validatePayload(ctx.payload);
	if (!proposal) {
		return {
			success: false,
			error: {
				code: "INVALID_PAYLOAD",
				message:
					"Missing or invalid scheduling fields: title, duration, slots (with valid start/end dates)",
			},
		};
	}

	// Check if a SchedulingHandler is available via extensions
	const schedulingHandler = ctx.extensions.schedulingHandler as SchedulingHandler | undefined;
	const contact = ctx.extensions.contact as Contact | undefined;

	if (schedulingHandler && contact) {
		// Delegate to SchedulingHandler for calendar availability and approval checks
		const decision = await schedulingHandler.evaluateProposal(
			proposal.schedulingId,
			contact,
			proposal,
		);

		return mapSchedulingDecisionToResult(proposal.schedulingId, decision);
	}

	// Fallback: grant-only evaluation when no SchedulingHandler is configured
	return handleGrantOnlyEvaluation(ctx, proposal);
}

function handleGrantOnlyEvaluation(
	ctx: TapActionContext,
	proposal: SchedulingProposal,
): TapActionResult {
	// Check if grants cover this scheduling request
	const matchingGrants = findApplicableSchedulingGrants(
		createGrantSet(ctx.peer.grantsToPeer, ""),
		proposal,
	);

	if (matchingGrants.length === 0) {
		ctx.events.emit({
			type: "scheduling/rejected",
			summary: `No matching grant for scheduling request: ${proposal.title}`,
			data: {
				schedulingId: proposal.schedulingId,
				title: proposal.title,
				duration: proposal.duration,
			},
		});

		return {
			success: false,
			data: {
				type: "scheduling/reject",
				schedulingId: proposal.schedulingId,
				reason: "No active scheduling grant covers this request",
			},
			error: {
				code: "NO_MATCHING_GRANT",
				message: "No active scheduling grant covers this request",
			},
		};
	}

	// Filter slots that match grant constraints
	const schedulableSlots = findSchedulableSchedulingSlots(matchingGrants, proposal);

	if (schedulableSlots.length === 0) {
		ctx.events.emit({
			type: "scheduling/rejected",
			summary: `No proposed slots match scheduling grant constraints for: ${proposal.title}`,
			data: {
				schedulingId: proposal.schedulingId,
				title: proposal.title,
				duration: proposal.duration,
			},
		});

		return {
			success: false,
			data: {
				type: "scheduling/reject",
				schedulingId: proposal.schedulingId,
				reason: "No proposed time slots match grant constraints",
			},
			error: {
				code: "NO_MATCHING_SLOTS",
				message: "No proposed time slots match scheduling grant constraints",
			},
		};
	}

	// Accept the first available slot
	const acceptedSlot = schedulableSlots[0] as TimeSlot;

	ctx.events.emit({
		type: "scheduling/accepted",
		summary: `Accepted scheduling request: ${proposal.title} at ${acceptedSlot.start}`,
		data: {
			schedulingId: proposal.schedulingId,
			title: proposal.title,
			acceptedSlot,
		},
	});

	return {
		success: true,
		data: {
			type: "scheduling/accept",
			schedulingId: proposal.schedulingId,
			acceptedSlot,
			note: `Confirmed: ${proposal.title}`,
		},
	};
}

function validatePayload(payload: Record<string, unknown>): SchedulingProposal | null {
	return parseSchedulingActionPayload(payload, {
		defaultSchedulingId: () => `sch_${Date.now()}`,
		defaultOriginTimezone: "UTC",
		copySlots: true,
		includeLocation: false,
	});
}
