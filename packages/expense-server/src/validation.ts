import { type ExpenseParticipant, parseUsdcAmount } from "@trustedagents/app-expenses";
import { badRequest } from "./errors.js";
import type {
	CreateExpenseGroupInput,
	CreateSettlementIntentInput,
	LogExpenseInput,
} from "./types.js";

const SETTLEMENT_REASONS = new Set(["manual", "threshold", "schedule"]);

export function parseCreateGroupInput(input: unknown): CreateExpenseGroupInput {
	const record = asRecord(input);
	const members = parseParticipants(record.members, "members");
	return {
		members,
		chain: parseNonEmptyString(record.chain, "chain"),
		...(record.settlementThreshold !== undefined
			? { settlementThreshold: parseUsdcDecimal(record.settlementThreshold, "settlementThreshold") }
			: {}),
	};
}

export function parseLogExpenseInput(input: unknown): LogExpenseInput {
	const record = asRecord(input);
	const amount = parseUsdcDecimal(record.amount, "amount");
	return {
		...(record.groupId !== undefined
			? { groupId: parseNonEmptyString(record.groupId, "groupId") }
			: {}),
		idempotencyKey: parseNonEmptyString(record.idempotencyKey, "idempotencyKey"),
		creator: parseParticipant(record.creator, "creator"),
		paidBy: parseParticipant(record.paidBy, "paidBy"),
		amount,
		description: parseNonEmptyString(record.description, "description"),
		...(record.category !== undefined
			? { category: parseNonEmptyString(record.category, "category") }
			: {}),
		participants: parseParticipants(record.participants, "participants"),
		...(record.occurredAt !== undefined
			? { occurredAt: parseDateString(record.occurredAt, "occurredAt") }
			: {}),
	};
}

export function parseCreateSettlementIntentInput(
	groupId: string,
	input: unknown,
): CreateSettlementIntentInput {
	const record = asRecord(input);
	const reason = parseNonEmptyString(record.reason, "reason");
	if (!SETTLEMENT_REASONS.has(reason)) {
		throw badRequest("reason must be manual, threshold, or schedule");
	}
	return {
		groupId,
		reason: reason as CreateSettlementIntentInput["reason"],
		idempotencyKey: parseNonEmptyString(record.idempotencyKey, "idempotencyKey"),
		...(record.expiresAt !== undefined
			? { expiresAt: parseDateString(record.expiresAt, "expiresAt") }
			: {}),
	};
}

function parseParticipants(value: unknown, field: string): ExpenseParticipant[] {
	if (!Array.isArray(value)) {
		throw badRequest(`${field} must be an array`);
	}
	if (value.length < 2) {
		throw badRequest(`${field} must include at least two participants`);
	}
	return value.map((participant, index) => parseParticipant(participant, `${field}[${index}]`));
}

function parseParticipant(value: unknown, field: string): ExpenseParticipant {
	const record = asRecord(value, `${field} must be an object`);
	const agentId = parseAgentId(record.agentId, `${field}.agentId`);
	const chain = parseNonEmptyString(record.chain, `${field}.chain`);
	return {
		agentId,
		chain,
		...(record.displayName !== undefined
			? { displayName: parseNonEmptyString(record.displayName, `${field}.displayName`) }
			: {}),
		...(record.address !== undefined
			? { address: parseEthereumAddress(record.address, `${field}.address`) }
			: {}),
	};
}

function asRecord(
	value: unknown,
	message = "request body must be an object",
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw badRequest(message);
	}
	return value as Record<string, unknown>;
}

function parseAgentId(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw badRequest(`${field} must be a non-negative integer`);
	}
	return value;
}

function parseNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw badRequest(`${field} must be a non-empty string`);
	}
	return value.trim();
}

function parseUsdcDecimal(value: unknown, field: string): string {
	const amount = parseNonEmptyString(value, field);
	try {
		parseUsdcAmount(amount);
		return amount;
	} catch (err: unknown) {
		throw badRequest(err instanceof Error ? err.message : `${field} must be a valid USDC amount`);
	}
}

function parseDateString(value: unknown, field: string): string {
	const text = parseNonEmptyString(value, field);
	if (Number.isNaN(new Date(text).getTime())) {
		throw badRequest(`${field} must be a valid ISO date string`);
	}
	return text;
}

function parseEthereumAddress(value: unknown, field: string): `0x${string}` {
	const text = parseNonEmptyString(value, field);
	if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
		throw badRequest(`${field} must be an Ethereum address`);
	}
	return text as `0x${string}`;
}
