import { describe, expect, it } from "vitest";
import { InMemoryExpenseStore, createExpenseLedger } from "../src/index.js";

const alice = {
	agentId: 1,
	chain: "eip155:8453",
	displayName: "Alice",
	address: "0x1111111111111111111111111111111111111111" as const,
};
const bob = {
	agentId: 2,
	chain: "eip155:8453",
	displayName: "Bob",
	address: "0x2222222222222222222222222222222222222222" as const,
};
const carol = {
	agentId: 3,
	chain: "eip155:8453",
	displayName: "Carol",
	address: "0x3333333333333333333333333333333333333333" as const,
};

describe("expense ledger", () => {
	it("logs an equal-split expense and computes net balances", async () => {
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });

		const group = await ledger.createGroup({
			members: [alice, bob],
			chain: "eip155:8453",
		});
		const expense = await ledger.logExpense({
			groupId: group.groupId,
			idempotencyKey: "groceries-1",
			creator: alice,
			paidBy: alice,
			amount: "45",
			description: "groceries",
			category: "household",
			participants: [alice, bob],
			occurredAt: "2026-04-23T20:00:00.000Z",
		});

		expect(expense.amountMinor).toBe("45000000");
		expect(expense.splits).toEqual([
			{ agentId: 1, chain: "eip155:8453", amountMinor: "22500000" },
			{ agentId: 2, chain: "eip155:8453", amountMinor: "22500000" },
		]);

		const balance = await ledger.getBalance(group.groupId);
		expect(balance.shares).toEqual([
			{ agentId: 1, chain: "eip155:8453", netMinor: "22500000" },
			{ agentId: 2, chain: "eip155:8453", netMinor: "-22500000" },
		]);
	});

	it("returns the existing expense for duplicate idempotency keys", async () => {
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
		const group = await ledger.createGroup({ members: [alice, bob], chain: "eip155:8453" });

		const first = await ledger.logExpense({
			groupId: group.groupId,
			idempotencyKey: "same-key",
			creator: alice,
			paidBy: alice,
			amount: "45",
			description: "groceries",
			participants: [alice, bob],
		});
		const second = await ledger.logExpense({
			groupId: group.groupId,
			idempotencyKey: "same-key",
			creator: alice,
			paidBy: alice,
			amount: "99",
			description: "ignored duplicate",
			participants: [alice, bob],
		});

		expect(second).toEqual(first);
		expect((await ledger.listHistory(group.groupId)).expenses).toHaveLength(1);
	});

	it("rejects expenses whose participants do not match the existing group", async () => {
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
		const group = await ledger.createGroup({ members: [alice, bob], chain: "eip155:8453" });

		await expect(
			ledger.logExpense({
				groupId: group.groupId,
				idempotencyKey: "wrong-members",
				creator: alice,
				paidBy: alice,
				amount: "45",
				description: "groceries",
				participants: [alice, carol],
			}),
		).rejects.toThrow("Expense participants must match group members");
	});

	it("creates a settlement intent for the net debtor", async () => {
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
		const group = await ledger.createGroup({ members: [alice, bob], chain: "eip155:8453" });
		await ledger.logExpense({
			groupId: group.groupId,
			idempotencyKey: "groceries-1",
			creator: alice,
			paidBy: alice,
			amount: "45",
			description: "groceries",
			participants: [alice, bob],
		});

		const settlement = await ledger.createSettlementIntent({
			groupId: group.groupId,
			reason: "manual",
			idempotencyKey: "settle-1",
		});

		expect(settlement.debtor.agentId).toBe(2);
		expect(settlement.creditor.agentId).toBe(1);
		expect(settlement.amountMinor).toBe("22500000");
		expect(settlement.chain).toBe("eip155:8453");
		expect(settlement.toAddress).toBe(alice.address);
	});

	it("returns the existing pending settlement for the same net balance", async () => {
		const store = new InMemoryExpenseStore();
		const ledger = createExpenseLedger({ store });
		const group = await ledger.createGroup({ members: [alice, bob], chain: "eip155:8453" });
		await ledger.logExpense({
			groupId: group.groupId,
			idempotencyKey: "groceries-1",
			creator: alice,
			paidBy: alice,
			amount: "45",
			description: "groceries",
			participants: [alice, bob],
		});

		const first = await ledger.createSettlementIntent({
			groupId: group.groupId,
			reason: "manual",
			idempotencyKey: "settle-1",
		});
		const second = await ledger.createSettlementIntent({
			groupId: group.groupId,
			reason: "manual",
			idempotencyKey: "settle-2",
		});

		expect(second).toEqual(first);
		expect((await store.snapshot()).settlements).toHaveLength(1);
	});

	it("enforces threshold settlement minimums", async () => {
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
		const group = await ledger.createGroup({
			members: [alice, bob],
			chain: "eip155:8453",
			settlementThreshold: "30",
		});
		await ledger.logExpense({
			groupId: group.groupId,
			idempotencyKey: "groceries-1",
			creator: alice,
			paidBy: alice,
			amount: "45",
			description: "groceries",
			participants: [alice, bob],
		});

		await expect(
			ledger.createSettlementIntent({
				groupId: group.groupId,
				reason: "threshold",
				idempotencyKey: "settle-threshold",
			}),
		).rejects.toThrow("Settlement amount is below the group threshold");
	});
});
