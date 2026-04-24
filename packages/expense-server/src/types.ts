import type {
	ExpenseGroup,
	ExpenseParticipant,
	ExpenseRecord,
	ExpenseSettlementIntent,
	ExpenseSettlementReason,
} from "@trustedagents/app-expenses";

export interface CreateExpenseGroupInput {
	members: ExpenseParticipant[];
	chain: string;
	settlementThreshold?: string;
}

export interface LogExpenseInput {
	groupId?: string;
	idempotencyKey: string;
	creator: ExpenseParticipant;
	paidBy: ExpenseParticipant;
	amount: string;
	description: string;
	category?: string;
	participants: ExpenseParticipant[];
	occurredAt?: string;
}

export interface CreateSettlementIntentInput {
	groupId: string;
	reason: ExpenseSettlementReason;
	idempotencyKey: string;
	expiresAt?: string;
}

export interface ExpenseHistory {
	groupId: string;
	expenses: ExpenseRecord[];
}

export interface ExpenseStoreSnapshot {
	groups: ExpenseGroup[];
	expenses: ExpenseRecord[];
	settlements: ExpenseSettlementIntent[];
}
