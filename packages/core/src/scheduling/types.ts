import { randomBytes } from "node:crypto";
import { ValidationError } from "../common/errors.js";

export interface TimeSlot {
	start: string;
	end: string;
}

export interface SchedulingProposal {
	type: "scheduling/propose" | "scheduling/counter";
	schedulingId: string;
	title: string;
	duration: number;
	slots: TimeSlot[];
	location?: string;
	note?: string;
	originTimezone: string;
}

export interface SchedulingAccept {
	type: "scheduling/accept";
	schedulingId: string;
	acceptedSlot: TimeSlot;
	note?: string;
}

export interface SchedulingReject {
	type: "scheduling/reject" | "scheduling/cancel";
	schedulingId: string;
	reason?: string;
}

export type SchedulingPayload = SchedulingProposal | SchedulingAccept | SchedulingReject;

export function generateSchedulingId(): string {
	return `sch_${randomBytes(15).toString("base64url").slice(0, 20)}`;
}

export function validateTimeSlot(slot: TimeSlot): void {
	const start = new Date(slot.start);
	const end = new Date(slot.end);
	if (start >= end) {
		throw new ValidationError("TimeSlot start must be before end");
	}
}

export function validateSchedulingProposal(proposal: SchedulingProposal): void {
	if (proposal.type !== "scheduling/propose" && proposal.type !== "scheduling/counter") {
		throw new ValidationError(
			`Invalid proposal type: ${proposal.type}. Must be scheduling/propose or scheduling/counter`,
		);
	}
	if (!proposal.title || proposal.title.trim() === "") {
		throw new ValidationError("Proposal title must not be empty");
	}
	if (proposal.duration <= 0) {
		throw new ValidationError("Proposal duration must be greater than 0");
	}
	if (!proposal.slots || proposal.slots.length === 0) {
		throw new ValidationError("Proposal must include at least one time slot");
	}
	for (const slot of proposal.slots) {
		validateTimeSlot(slot);
	}
	if (!proposal.originTimezone || proposal.originTimezone.trim() === "") {
		throw new ValidationError("Proposal originTimezone must not be empty");
	}
}

export function validateSchedulingAccept(accept: SchedulingAccept): void {
	if (accept.type !== "scheduling/accept") {
		throw new ValidationError(`Invalid accept type: ${accept.type}. Must be scheduling/accept`);
	}
	if (!accept.schedulingId || accept.schedulingId.trim() === "") {
		throw new ValidationError("Accept schedulingId must not be empty");
	}
	validateTimeSlot(accept.acceptedSlot);
}

export function validateSchedulingReject(reject: SchedulingReject): void {
	if (reject.type !== "scheduling/reject" && reject.type !== "scheduling/cancel") {
		throw new ValidationError(
			`Invalid reject type: ${reject.type}. Must be scheduling/reject or scheduling/cancel`,
		);
	}
	if (!reject.schedulingId || reject.schedulingId.trim() === "") {
		throw new ValidationError("Reject schedulingId must not be empty");
	}
}
