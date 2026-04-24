#!/usr/bin/env node
import { resolve } from "node:path";
import { FileExpenseStore, createExpenseHttpServer, createExpenseLedger } from "./index.js";

const host = process.env.EXPENSE_SERVER_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.EXPENSE_SERVER_PORT ?? "8787", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	throw new Error(
		`EXPENSE_SERVER_PORT must be between 0 and 65535, got ${process.env.EXPENSE_SERVER_PORT}`,
	);
}

const apiToken = process.env.EXPENSE_SERVER_API_TOKEN?.trim();
if (!apiToken && !isLoopbackHost(host)) {
	throw new Error("EXPENSE_SERVER_API_TOKEN is required when binding outside loopback");
}

const dataFile = resolve(process.env.EXPENSE_SERVER_DATA_FILE ?? "expense-ledger.json");
const ledger = createExpenseLedger({ store: new FileExpenseStore(dataFile) });
const server = createExpenseHttpServer({ ledger, ...(apiToken ? { apiToken } : {}) });
const url = await server.listen({ host, port });
process.stdout.write(`tap expense server listening on ${url}\nledger: ${dataFile}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void server.stop().then(() => process.exit(0));
	});
}

function isLoopbackHost(value: string): boolean {
	return value === "localhost" || value === "127.0.0.1" || value === "::1";
}
