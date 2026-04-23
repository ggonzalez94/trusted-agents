import { afterEach, describe, expect, it } from "vitest";
import {
	InMemoryExpenseStore,
	createExpenseHttpServer,
	createExpenseLedger,
} from "../src/index.js";

const alice = {
	agentId: 1,
	chain: "eip155:8453",
	displayName: "Alice",
	address: "0x1111111111111111111111111111111111111111",
};
const bob = {
	agentId: 2,
	chain: "eip155:8453",
	displayName: "Bob",
	address: "0x2222222222222222222222222222222222222222",
};

let server: ReturnType<typeof createExpenseHttpServer> | undefined;

afterEach(async () => {
	await server?.stop();
	server = undefined;
});

describe("expense HTTP API", () => {
	it("creates a group, logs an expense, reads balance and history, and creates settlement", async () => {
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
		server = createExpenseHttpServer({ ledger });
		const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });

		const health = await getJson(`${baseUrl}/health`);
		expect(health).toEqual({ status: "ok" });

		const group = await postJson(`${baseUrl}/v1/groups`, {
			members: [alice, bob],
			chain: "eip155:8453",
		});
		expect(group.groupId).toBe("expgrp_eip155_8453_1_eip155_8453_2");

		const expense = await postJson(`${baseUrl}/v1/expenses`, {
			groupId: group.groupId,
			idempotencyKey: "groceries-1",
			creator: alice,
			paidBy: alice,
			amount: "45",
			description: "groceries",
			category: "household",
			participants: [alice, bob],
		});
		expect(expense.description).toBe("groceries");

		const balance = await getJson(`${baseUrl}/v1/groups/${group.groupId}/balance`);
		expect(balance.shares).toContainEqual({
			agentId: 2,
			chain: "eip155:8453",
			netMinor: "-22500000",
		});

		const history = await getJson(`${baseUrl}/v1/groups/${group.groupId}/history`);
		expect(history.expenses).toHaveLength(1);

		const settlement = await postJson(`${baseUrl}/v1/groups/${group.groupId}/settlements`, {
			reason: "manual",
			idempotencyKey: "settle-1",
		});
		expect(settlement.debtor.agentId).toBe(2);
		expect(settlement.amountMinor).toBe("22500000");
	});
});

async function getJson(url: string): Promise<Record<string, unknown>> {
	const response = await fetch(url);
	expect(response.ok).toBe(true);
	return (await response.json()) as Record<string, unknown>;
}

async function postJson(
	url: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(response.ok).toBe(true);
	return (await response.json()) as Record<string, unknown>;
}
