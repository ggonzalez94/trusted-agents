export const EXPENSE_SETTLE_SCOPE = "expense/settle" as const;

export type ExpenseAsset = "usdc";
export type ExpenseSettlementReason = "manual" | "threshold" | "schedule";
export type ExpenseSettlementSchedule = "manual" | "daily" | "weekly" | "monthly";

export interface ExpenseParticipant {
	agentId: number;
	chain: string;
	displayName?: string;
	address?: `0x${string}`;
}

export interface ExpenseSplitShare {
	agentId: number;
	chain: string;
	amountMinor: string;
}

export interface ExpenseGroup {
	groupId: string;
	members: ExpenseParticipant[];
	split: "equal";
	chain: string;
	asset: ExpenseAsset;
	settlementThresholdMinor?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ExpenseRecord {
	eventId: string;
	groupId: string;
	idempotencyKey: string;
	creator: ExpenseParticipant;
	paidBy: ExpenseParticipant;
	amountMinor: string;
	asset: ExpenseAsset;
	expenseCurrency: "USD";
	description: string;
	category?: string;
	occurredAt: string;
	participants: ExpenseParticipant[];
	splits: ExpenseSplitShare[];
	createdAt: string;
}

export interface ExpenseBalanceShare {
	agentId: number;
	chain: string;
	netMinor: string;
}

export interface ExpenseBalance {
	groupId: string;
	asset: ExpenseAsset;
	shares: ExpenseBalanceShare[];
}

export interface ExpenseSettlementIntent {
	intentId: string;
	groupId: string;
	debtor: ExpenseParticipant;
	creditor: ExpenseParticipant;
	amountMinor: string;
	asset: ExpenseAsset;
	chain: string;
	tokenAddress?: `0x${string}`;
	fromAddress?: `0x${string}`;
	toAddress?: `0x${string}`;
	reason: ExpenseSettlementReason;
	status: "pending" | "submitted" | "completed" | "failed" | "expired" | "canceled";
	idempotencyKey: string;
	createdAt: string;
	expiresAt: string;
}

export interface ExpenseSettlementGrantRequest {
	asset: ExpenseAsset;
	amount: string;
	chain: string;
	reason: ExpenseSettlementReason;
	schedule?: ExpenseSettlementSchedule;
}
