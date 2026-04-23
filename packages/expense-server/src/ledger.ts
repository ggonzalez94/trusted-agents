import { randomUUID } from "node:crypto";
import {
	type ExpenseBalance,
	type ExpenseBalanceShare,
	type ExpenseGroup,
	type ExpenseParticipant,
	type ExpenseRecord,
	type ExpenseSettlementIntent,
	buildEqualSplits,
	deriveExpenseGroupId,
	formatUsdcMinor,
	parseUsdcAmount,
} from "@trustedagents/app-expenses";
import type { ExpenseStore } from "./store.js";
import type {
	CreateExpenseGroupInput,
	CreateSettlementIntentInput,
	ExpenseHistory,
	LogExpenseInput,
} from "./types.js";

export interface ExpenseLedger {
	createGroup(input: CreateExpenseGroupInput): Promise<ExpenseGroup>;
	logExpense(input: LogExpenseInput): Promise<ExpenseRecord>;
	getBalance(groupId: string): Promise<ExpenseBalance>;
	listHistory(groupId: string): Promise<ExpenseHistory>;
	createSettlementIntent(input: CreateSettlementIntentInput): Promise<ExpenseSettlementIntent>;
}

export function createExpenseLedger(options: {
	store: ExpenseStore;
	now?: () => Date;
}): ExpenseLedger {
	return new DefaultExpenseLedger(options.store, options.now ?? (() => new Date()));
}

class DefaultExpenseLedger implements ExpenseLedger {
	constructor(
		private readonly store: ExpenseStore,
		private readonly now: () => Date,
	) {}

	async createGroup(input: CreateExpenseGroupInput): Promise<ExpenseGroup> {
		assertMembers(input.members);
		const timestamp = this.now().toISOString();
		const groupId = deriveExpenseGroupId(input.members);
		return await this.store.upsertGroup({
			groupId,
			members: input.members,
			split: "equal",
			chain: input.chain,
			asset: "usdc",
			...(input.settlementThreshold
				? { settlementThresholdMinor: parseUsdcAmount(input.settlementThreshold).toString() }
				: {}),
			createdAt: timestamp,
			updatedAt: timestamp,
		});
	}

	async logExpense(input: LogExpenseInput): Promise<ExpenseRecord> {
		assertMembers(input.participants);
		const groupId = input.groupId ?? deriveExpenseGroupId(input.participants);
		const existing = await this.store.findExpenseByIdempotencyKey(groupId, input.idempotencyKey);
		if (existing) {
			return existing;
		}

		const group =
			(await this.store.getGroup(groupId)) ??
			(await this.createGroup({ members: input.participants, chain: input.creator.chain }));
		const amountMinor = parseUsdcAmount(input.amount);
		const timestamp = this.now().toISOString();
		const expense: ExpenseRecord = {
			eventId: `expev_${randomUUID()}`,
			groupId: group.groupId,
			idempotencyKey: input.idempotencyKey,
			creator: input.creator,
			paidBy: input.paidBy,
			amountMinor: amountMinor.toString(),
			asset: "usdc",
			expenseCurrency: "USD",
			description: input.description,
			...(input.category ? { category: input.category } : {}),
			occurredAt: input.occurredAt ?? timestamp,
			participants: input.participants,
			splits: buildEqualSplits(amountMinor, input.participants),
			createdAt: timestamp,
		};

		return await this.store.appendExpense(expense);
	}

	async getBalance(groupId: string): Promise<ExpenseBalance> {
		const group = await this.requireGroup(groupId);
		const totals = new Map<string, bigint>();
		for (const member of group.members) {
			totals.set(memberKey(member), 0n);
		}

		for (const expense of await this.store.listExpenses(groupId)) {
			addToMap(totals, memberKey(expense.paidBy), BigInt(expense.amountMinor));
			for (const split of expense.splits) {
				addToMap(totals, `${split.chain}:${split.agentId}`, -BigInt(split.amountMinor));
			}
		}

		const shares: ExpenseBalanceShare[] = group.members.map((member) => ({
			agentId: member.agentId,
			chain: member.chain,
			netMinor: (totals.get(memberKey(member)) ?? 0n).toString(),
		}));

		return { groupId, asset: "usdc", shares };
	}

	async listHistory(groupId: string): Promise<ExpenseHistory> {
		await this.requireGroup(groupId);
		return { groupId, expenses: await this.store.listExpenses(groupId) };
	}

	async createSettlementIntent(
		input: CreateSettlementIntentInput,
	): Promise<ExpenseSettlementIntent> {
		const existing = await this.store.findSettlementByIdempotencyKey(
			input.groupId,
			input.idempotencyKey,
		);
		if (existing) {
			return existing;
		}

		const group = await this.requireGroup(input.groupId);
		const balance = await this.getBalance(input.groupId);
		const debtorShare = minBy(balance.shares, (share) => BigInt(share.netMinor));
		const creditorShare = maxBy(balance.shares, (share) => BigInt(share.netMinor));
		if (!debtorShare || !creditorShare) {
			throw new Error("Cannot settle an empty group");
		}

		const debtorAmount = -BigInt(debtorShare.netMinor);
		const creditorAmount = BigInt(creditorShare.netMinor);
		if (debtorAmount <= 0n || creditorAmount <= 0n) {
			throw new Error("Group has no outstanding balance to settle");
		}

		const amountMinor = debtorAmount < creditorAmount ? debtorAmount : creditorAmount;
		const debtor = findMember(group.members, debtorShare);
		const creditor = findMember(group.members, creditorShare);
		const createdAt = this.now();
		const expiresAt =
			input.expiresAt ?? new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
		const settlement: ExpenseSettlementIntent = {
			intentId: `expset_${randomUUID()}`,
			groupId: input.groupId,
			debtor,
			creditor,
			amountMinor: amountMinor.toString(),
			asset: "usdc",
			chain: group.chain,
			...(debtor.address ? { fromAddress: debtor.address } : {}),
			...(creditor.address ? { toAddress: creditor.address } : {}),
			reason: input.reason,
			status: "pending",
			idempotencyKey: input.idempotencyKey,
			createdAt: createdAt.toISOString(),
			expiresAt,
		};

		return await this.store.appendSettlement(settlement);
	}

	private async requireGroup(groupId: string): Promise<ExpenseGroup> {
		const group = await this.store.getGroup(groupId);
		if (!group) {
			throw new Error(`Expense group not found: ${groupId}`);
		}
		return group;
	}
}

function assertMembers(members: ExpenseParticipant[]): void {
	if (members.length < 2) {
		throw new Error("Expense groups require at least two members");
	}
}

function memberKey(member: Pick<ExpenseParticipant, "agentId" | "chain">): string {
	return `${member.chain}:${member.agentId}`;
}

function addToMap(map: Map<string, bigint>, key: string, delta: bigint): void {
	map.set(key, (map.get(key) ?? 0n) + delta);
}

function findMember(
	members: ExpenseParticipant[],
	share: Pick<ExpenseBalanceShare, "agentId" | "chain">,
): ExpenseParticipant {
	const member = members.find(
		(candidate) => candidate.agentId === share.agentId && candidate.chain === share.chain,
	);
	if (!member) {
		throw new Error(`Expense group member missing for ${share.chain}:${share.agentId}`);
	}
	return member;
}

function minBy<T>(items: T[], score: (item: T) => bigint): T | undefined {
	return items.reduce<T | undefined>(
		(best, item) => (best === undefined || score(item) < score(best) ? item : best),
		undefined,
	);
}

function maxBy<T>(items: T[], score: (item: T) => bigint): T | undefined {
	return items.reduce<T | undefined>(
		(best, item) => (best === undefined || score(item) > score(best) ? item : best),
		undefined,
	);
}

export function settlementAmountDecimal(intent: ExpenseSettlementIntent): string {
	return formatUsdcMinor(intent.amountMinor);
}
