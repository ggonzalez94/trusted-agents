import type {
	Contact,
	SchedulingDecision,
	SchedulingHandler,
	TapActionContext,
	TapActionResult,
} from "trusted-agents-core";
import { findApplicableSchedulingGrants, findSchedulableSchedulingSlots } from "./grants.js";
import type { SchedulingProposal, TimeSlot } from "./types.js";

export async function handleSchedulingRequest(ctx: TapActionContext): Promise<TapActionResult> {
	const proposal = validatePayload(ctx.payload);
	if (!proposal) {
		return {
			success: false,
			error: {
				code: "INVALID_PAYLOAD",
				message:
					"Missing or invalid scheduling/request fields: title, durationMinutes, proposedSlots",
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

		return mapDecisionToResult(proposal.schedulingId, decision);
	}

	// Fallback: grant-only evaluation when no SchedulingHandler is configured
	return handleGrantOnlyEvaluation(ctx, proposal);
}

function mapDecisionToResult(schedulingId: string, decision: SchedulingDecision): TapActionResult {
	switch (decision.action) {
		case "confirm":
			return {
				success: true,
				data: {
					type: "scheduling/accept",
					schedulingId,
					acceptedSlot: decision.slot,
				},
			};
		case "counter":
			return {
				success: true,
				data: {
					type: "scheduling/counter",
					schedulingId,
					counterSlots: decision.slots,
				},
			};
		case "reject":
			return {
				success: false,
				data: {
					type: "scheduling/reject",
					schedulingId,
					reason: decision.reason,
				},
				error: {
					code: "REJECTED",
					message: decision.reason,
				},
			};
		case "defer":
			return {
				success: false,
				error: {
					code: "DEFERRED",
					message: "Scheduling request deferred for approval",
				},
			};
	}
}

function handleGrantOnlyEvaluation(
	ctx: TapActionContext,
	proposal: SchedulingProposal,
): TapActionResult {
	// Check if grants cover this scheduling request
	const matchingGrants = findApplicableSchedulingGrants(
		{ version: "tap-grants/v1", updatedAt: "", grants: ctx.peer.grantsToPeer },
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
	if (payload.type !== "scheduling/propose" && payload.type !== "scheduling/counter") {
		return null;
	}

	if (typeof payload.title !== "string" || payload.title.length === 0) {
		return null;
	}

	if (typeof payload.durationMinutes !== "number" || payload.durationMinutes <= 0) {
		return null;
	}

	if (!Array.isArray(payload.proposedSlots) || payload.proposedSlots.length === 0) {
		return null;
	}

	const slots: TimeSlot[] = [];
	for (const slot of payload.proposedSlots) {
		if (
			typeof slot !== "object" ||
			slot === null ||
			typeof (slot as Record<string, unknown>).start !== "string" ||
			typeof (slot as Record<string, unknown>).end !== "string"
		) {
			return null;
		}
		const s = slot as { start: string; end: string };
		const startDate = new Date(s.start);
		const endDate = new Date(s.end);
		if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
			return null;
		}
		if (startDate >= endDate) {
			return null;
		}
		slots.push({ start: s.start, end: s.end });
	}

	const schedulingId =
		typeof payload.schedulingId === "string" && payload.schedulingId.length > 0
			? payload.schedulingId
			: `sch_${Date.now()}`;

	const timezone =
		typeof payload.timezone === "string" && payload.timezone.length > 0 ? payload.timezone : "UTC";

	return {
		type: payload.type as "scheduling/propose" | "scheduling/counter",
		schedulingId,
		title: payload.title,
		duration: payload.durationMinutes,
		slots,
		originTimezone: timezone,
		...(typeof payload.note === "string" && payload.note.length > 0 ? { note: payload.note } : {}),
	};
}
