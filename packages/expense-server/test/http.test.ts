import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	FileExpenseStore,
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
let tempRoot: string | undefined;

afterEach(async () => {
	await server?.stop();
	server = undefined;
	if (tempRoot) {
		await rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
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

	it("requires bearer auth when configured", async () => {
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
		server = createExpenseHttpServer({ ledger, apiToken: "secret-token" });
		const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });

		const health = await fetch(`${baseUrl}/health`);
		expect(health.status).toBe(200);

		const unauthenticated = await fetch(`${baseUrl}/v1/groups`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ members: [alice, bob], chain: "eip155:8453" }),
		});
		expect(unauthenticated.status).toBe(401);
		expect(await unauthenticated.json()).toEqual({
			error: { code: "UNAUTHENTICATED", message: "Missing or invalid expense API token" },
		});

		const group = await postJson(
			`${baseUrl}/v1/groups`,
			{ members: [alice, bob], chain: "eip155:8453" },
			"secret-token",
		);
		expect(group.groupId).toBe("expgrp_eip155_8453_1_eip155_8453_2");
	});

	it("returns 400 for invalid request bodies", async () => {
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
		server = createExpenseHttpServer({ ledger });
		const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });

		const response = await fetch(`${baseUrl}/v1/groups`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ members: "not-an-array", chain: "eip155:8453" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: { code: "INVALID_REQUEST", message: "members must be an array" },
		});
	});

	it("persists ledger state with the file store", async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-expense-store-"));
		const storePath = join(tempRoot, "ledger.json");
		const firstLedger = createExpenseLedger({ store: new FileExpenseStore(storePath) });
		const group = await firstLedger.createGroup({ members: [alice, bob], chain: "eip155:8453" });
		await firstLedger.logExpense({
			groupId: group.groupId,
			idempotencyKey: "groceries-1",
			creator: alice,
			paidBy: alice,
			amount: "45",
			description: "groceries",
			participants: [alice, bob],
		});

		const secondLedger = createExpenseLedger({ store: new FileExpenseStore(storePath) });
		const history = await secondLedger.listHistory(group.groupId);
		const balance = await secondLedger.getBalance(group.groupId);

		expect(history.expenses).toHaveLength(1);
		expect(balance.shares).toContainEqual({
			agentId: 2,
			chain: "eip155:8453",
			netMinor: "-22500000",
		});
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
	apiToken?: string,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
		},
		body: JSON.stringify(body),
	});
	expect(response.ok).toBe(true);
	return (await response.json()) as Record<string, unknown>;
}
