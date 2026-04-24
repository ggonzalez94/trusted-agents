import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
	InMemoryExpenseStore,
	createExpenseHttpServer,
	createExpenseLedger,
} from "../../expense-server/src/index.js";
import { runCli } from "./helpers/run-cli.js";

describe("tap expenses commands", () => {
	let tempRoot: string;
	let dataDir: string;
	let server: ReturnType<typeof createExpenseHttpServer> | undefined;
	let serverUrl: string;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-expenses-"));
		dataDir = join(tempRoot, "agent");
		await mkdir(dataDir, { recursive: true });
		await writeFile(
			join(dataDir, "config.yaml"),
			[
				"agent_id: 1",
				"chain: eip155:8453",
				"ows:",
				"  wallet: demo-wallet",
				"  api_key: ows_key_demo",
			].join("\n"),
			"utf-8",
		);
		await writeFile(
			join(dataDir, "contacts.json"),
			JSON.stringify({
				contacts: [
					{
						connectionId: "conn-bob",
						peerAgentId: 2,
						peerChain: "eip155:8453",
						peerOwnerAddress: "0x2222222222222222222222222222222222222222",
						peerDisplayName: "Bob",
						peerAgentAddress: "0x2222222222222222222222222222222222222222",
						permissions: {
							grantedByMe: { version: "tap-grants/v1", updatedAt: "", grants: [] },
							grantedByPeer: { version: "tap-grants/v1", updatedAt: "", grants: [] },
						},
						establishedAt: "2026-04-23T00:00:00.000Z",
						lastContactAt: "2026-04-23T00:00:00.000Z",
						status: "active",
					},
				],
			}),
			"utf-8",
		);
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
		server = createExpenseHttpServer({ ledger });
		serverUrl = await server.listen({ host: "127.0.0.1", port: 0 });
	});

	afterEach(async () => {
		await server?.stop();
		server = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("sets up the server URL and settlement address", async () => {
		const result = await runCli([
			"--data-dir",
			dataDir,
			"--json",
			"expenses",
			"setup",
			"--server",
			serverUrl,
			"--settlement-address",
			"0x1111111111111111111111111111111111111111",
		]);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout) as { data: { server_url: string } };
		expect(output.data.server_url).toBe(serverUrl);
		const yaml = YAML.parse(await readFile(join(dataDir, "config.yaml"), "utf-8")) as {
			expenses?: { server_url?: string; settlement_address?: string };
		};
		expect(yaml.expenses?.server_url).toBe(serverUrl);
		expect(yaml.expenses?.settlement_address).toBe("0x1111111111111111111111111111111111111111");
	});

	it("stores and uses the expense server API token", async () => {
		await server?.stop();
		const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
		server = createExpenseHttpServer({ ledger, apiToken: "secret-token" });
		serverUrl = await server.listen({ host: "127.0.0.1", port: 0 });

		const setup = await runCli([
			"--data-dir",
			dataDir,
			"--json",
			"expenses",
			"setup",
			"--server",
			serverUrl,
			"--api-token",
			"secret-token",
		]);
		expect(setup.exitCode).toBe(0);

		const group = await runCli([
			"--data-dir",
			dataDir,
			"--json",
			"expenses",
			"group",
			"create",
			"Bob",
		]);
		expect(group.exitCode).toBe(0);
		expect(JSON.parse(group.stdout).data.group_id).toBe("expgrp_eip155_8453_1_eip155_8453_2");

		const yaml = YAML.parse(await readFile(join(dataDir, "config.yaml"), "utf-8")) as {
			expenses?: { api_token?: string };
		};
		expect(yaml.expenses?.api_token).toBe("secret-token");
	});

	it("creates a group, logs an expense, reads balance/history, and creates settlement", async () => {
		await runCli([
			"--data-dir",
			dataDir,
			"--json",
			"expenses",
			"setup",
			"--server",
			serverUrl,
			"--settlement-address",
			"0x1111111111111111111111111111111111111111",
		]);

		const group = await runCli([
			"--data-dir",
			dataDir,
			"--json",
			"expenses",
			"group",
			"create",
			"Bob",
		]);
		expect(group.exitCode).toBe(0);
		expect(JSON.parse(group.stdout).data.group_id).toBe("expgrp_eip155_8453_1_eip155_8453_2");

		const logged = await runCli([
			"--data-dir",
			dataDir,
			"--json",
			"expenses",
			"log",
			"Bob",
			"45",
			"groceries",
			"--category",
			"household",
			"--idempotency-key",
			"groceries-1",
		]);
		expect(logged.exitCode).toBe(0);
		expect(JSON.parse(logged.stdout).data.amount).toBe("45");

		const balance = await runCli(["--data-dir", dataDir, "--json", "expenses", "balance", "Bob"]);
		expect(balance.exitCode).toBe(0);
		expect(JSON.parse(balance.stdout).data.shares).toContainEqual({
			agent_id: 2,
			chain: "eip155:8453",
			net_amount: "-22.5",
		});

		const history = await runCli(["--data-dir", dataDir, "--json", "expenses", "history", "Bob"]);
		expect(history.exitCode).toBe(0);
		expect(JSON.parse(history.stdout).data.expenses).toHaveLength(1);

		const settlement = await runCli([
			"--data-dir",
			dataDir,
			"--json",
			"expenses",
			"settle",
			"Bob",
			"--idempotency-key",
			"settle-1",
		]);
		expect(settlement.exitCode).toBe(0);
		expect(JSON.parse(settlement.stdout).data).toMatchObject({
			debtor_agent_id: 2,
			creditor_agent_id: 1,
			amount: "22.5",
			chain: "eip155:8453",
			to_address: "0x1111111111111111111111111111111111111111",
		});
	});
});
