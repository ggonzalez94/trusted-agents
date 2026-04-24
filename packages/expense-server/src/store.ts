import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
	listSettlements(groupId: string): Promise<ExpenseSettlementIntent[]>;
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

	async listSettlements(groupId: string): Promise<ExpenseSettlementIntent[]> {
		return [...(this.settlements.get(groupId) ?? [])];
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

export class FileExpenseStore implements ExpenseStore {
	private readonly writeMutex = new AsyncMutex();

	constructor(private readonly filePath: string) {}

	async getGroup(groupId: string): Promise<ExpenseGroup | undefined> {
		return (await this.load()).groups.find((group) => group.groupId === groupId);
	}

	async upsertGroup(group: ExpenseGroup): Promise<ExpenseGroup> {
		return await this.writeMutex.runExclusive(async () => {
			const snapshot = await this.load();
			const index = snapshot.groups.findIndex((candidate) => candidate.groupId === group.groupId);
			if (index >= 0) {
				const existing = snapshot.groups[index]!;
				const next = { ...existing, ...group, createdAt: existing.createdAt };
				snapshot.groups[index] = next;
				await this.save(snapshot);
				return next;
			}
			snapshot.groups.push(group);
			await this.save(snapshot);
			return group;
		});
	}

	async listExpenses(groupId: string): Promise<ExpenseRecord[]> {
		return (await this.load()).expenses.filter((expense) => expense.groupId === groupId);
	}

	async findExpenseByIdempotencyKey(
		groupId: string,
		idempotencyKey: string,
	): Promise<ExpenseRecord | undefined> {
		return (await this.load()).expenses.find(
			(expense) => expense.groupId === groupId && expense.idempotencyKey === idempotencyKey,
		);
	}

	async appendExpense(expense: ExpenseRecord): Promise<ExpenseRecord> {
		return await this.writeMutex.runExclusive(async () => {
			const snapshot = await this.load();
			snapshot.expenses.push(expense);
			await this.save(snapshot);
			return expense;
		});
	}

	async findSettlementByIdempotencyKey(
		groupId: string,
		idempotencyKey: string,
	): Promise<ExpenseSettlementIntent | undefined> {
		return (await this.load()).settlements.find(
			(settlement) =>
				settlement.groupId === groupId && settlement.idempotencyKey === idempotencyKey,
		);
	}

	async listSettlements(groupId: string): Promise<ExpenseSettlementIntent[]> {
		return (await this.load()).settlements.filter((settlement) => settlement.groupId === groupId);
	}

	async appendSettlement(settlement: ExpenseSettlementIntent): Promise<ExpenseSettlementIntent> {
		return await this.writeMutex.runExclusive(async () => {
			const snapshot = await this.load();
			snapshot.settlements.push(settlement);
			await this.save(snapshot);
			return settlement;
		});
	}

	async snapshot(): Promise<ExpenseStoreSnapshot> {
		const snapshot = await this.load();
		return {
			groups: [...snapshot.groups],
			expenses: [...snapshot.expenses],
			settlements: [...snapshot.settlements],
		};
	}

	private async load(): Promise<ExpenseStoreSnapshot> {
		try {
			const parsed = JSON.parse(
				await readFile(this.filePath, "utf-8"),
			) as Partial<ExpenseStoreSnapshot>;
			return {
				groups: Array.isArray(parsed.groups) ? parsed.groups : [],
				expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
				settlements: Array.isArray(parsed.settlements) ? parsed.settlements : [],
			};
		} catch (err: unknown) {
			if (isEnoent(err)) {
				return { groups: [], expenses: [], settlements: [] };
			}
			throw err;
		}
	}

	private async save(snapshot: ExpenseStoreSnapshot): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
		const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
		await writeFile(tempPath, JSON.stringify(snapshot, null, "\t"), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tempPath, this.filePath);
	}
}

class AsyncMutex {
	private current = Promise.resolve();

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.current;
		let release!: () => void;
		this.current = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

function isEnoent(err: unknown): boolean {
	return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
