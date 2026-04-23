#!/usr/bin/env node
import { InMemoryExpenseStore, createExpenseHttpServer, createExpenseLedger } from "./index.js";

const host = process.env.EXPENSE_SERVER_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.EXPENSE_SERVER_PORT ?? "8787", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	throw new Error(
		`EXPENSE_SERVER_PORT must be between 0 and 65535, got ${process.env.EXPENSE_SERVER_PORT}`,
	);
}

const ledger = createExpenseLedger({ store: new InMemoryExpenseStore() });
const server = createExpenseHttpServer({ ledger });
const url = await server.listen({ host, port });
process.stdout.write(`tap expense server listening on ${url}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void server.stop().then(() => process.exit(0));
	});
}
