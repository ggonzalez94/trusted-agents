import type {
	ExpenseGroup,
	ExpenseRecord,
	ExpenseSettlementIntent,
} from "@trustedagents/app-expenses";
import type { ExpenseStoreSnapshot } from "./types.js";

export interface ExpenseStore {
	getGroup(groupId: string): Promise<ExpenseGroup | undefined>;
	upsertGroup(group: ExpenseGroup): Promise<ExpenseGroup>;
	listExpenses(groupId: string): Promise<ExpenseRecord[]>;
	findExpenseByIdempotencyKey(
		groupId: string,
		idempotencyKey: string,
	): Promise<ExpenseRecord | undefined>;
	appendExpense(expense: ExpenseRecord): Promise<ExpenseRecord>;
	findSettlementByIdempotencyKey(
		groupId: string,
		idempotencyKey: string,
	): Promise<ExpenseSettlementIntent | undefined>;
	appendSettlement(settlement: ExpenseSettlementIntent): Promise<ExpenseSettlementIntent>;
	snapshot(): Promise<ExpenseStoreSnapshot>;
}

export class InMemoryExpenseStore implements ExpenseStore {
	private readonly groups = new Map<string, ExpenseGroup>();
	private readonly expenses = new Map<string, ExpenseRecord[]>();
	private readonly settlements = new Map<string, ExpenseSettlementIntent[]>();

	async getGroup(groupId: string): Promise<ExpenseGroup | undefined> {
		return this.groups.get(groupId);
	}

	async upsertGroup(group: ExpenseGroup): Promise<ExpenseGroup> {
		const existing = this.groups.get(group.groupId);
		const next = existing ? { ...existing, ...group, createdAt: existing.createdAt } : group;
		this.groups.set(group.groupId, next);
		return next;
	}

	async listExpenses(groupId: string): Promise<ExpenseRecord[]> {
		return [...(this.expenses.get(groupId) ?? [])];
	}

	async findExpenseByIdempotencyKey(
		groupId: string,
		idempotencyKey: string,
	): Promise<ExpenseRecord | undefined> {
		return (this.expenses.get(groupId) ?? []).find(
			(expense) => expense.idempotencyKey === idempotencyKey,
		);
	}

	async appendExpense(expense: ExpenseRecord): Promise<ExpenseRecord> {
		const expenses = this.expenses.get(expense.groupId) ?? [];
		expenses.push(expense);
		this.expenses.set(expense.groupId, expenses);
		return expense;
	}

	async findSettlementByIdempotencyKey(
		groupId: string,
		idempotencyKey: string,
	): Promise<ExpenseSettlementIntent | undefined> {
		return (this.settlements.get(groupId) ?? []).find(
			(settlement) => settlement.idempotencyKey === idempotencyKey,
		);
	}

	async appendSettlement(settlement: ExpenseSettlementIntent): Promise<ExpenseSettlementIntent> {
		const settlements = this.settlements.get(settlement.groupId) ?? [];
		settlements.push(settlement);
		this.settlements.set(settlement.groupId, settlements);
		return settlement;
	}

	async snapshot(): Promise<ExpenseStoreSnapshot> {
		return {
			groups: [...this.groups.values()],
			expenses: [...this.expenses.values()].flat(),
			settlements: [...this.settlements.values()].flat(),
		};
	}
}
