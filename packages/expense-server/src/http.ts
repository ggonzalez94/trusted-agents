import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExpenseLedger } from "./ledger.js";
import type {
	CreateExpenseGroupInput,
	CreateSettlementIntentInput,
	LogExpenseInput,
} from "./types.js";

export interface ExpenseHttpServer {
	listen(options: { host: string; port: number }): Promise<string>;
	stop(): Promise<void>;
}

export function createExpenseHttpServer(options: { ledger: ExpenseLedger }): ExpenseHttpServer {
	const server = createServer((req, res) => {
		void route(options.ledger, req, res).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message } });
		});
	});

	return {
		listen: async ({ host, port }) => {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					resolve();
				});
			});
			const address = server.address() as AddressInfo;
			return `http://${address.address}:${address.port}`;
		},
		stop: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function route(
	ledger: ExpenseLedger,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const method = req.method ?? "GET";
	const path = new URL(req.url ?? "/", "http://localhost").pathname;

	if (method === "GET" && path === "/health") {
		sendJson(res, 200, { status: "ok" });
		return;
	}

	if (method === "POST" && path === "/v1/groups") {
		sendJson(res, 200, await ledger.createGroup((await readJson(req)) as CreateExpenseGroupInput));
		return;
	}

	if (method === "POST" && path === "/v1/expenses") {
		sendJson(res, 200, await ledger.logExpense((await readJson(req)) as LogExpenseInput));
		return;
	}

	const balanceMatch = /^\/v1\/groups\/([^/]+)\/balance$/.exec(path);
	if (method === "GET" && balanceMatch?.[1]) {
		sendJson(res, 200, await ledger.getBalance(decodeURIComponent(balanceMatch[1])));
		return;
	}

	const historyMatch = /^\/v1\/groups\/([^/]+)\/history$/.exec(path);
	if (method === "GET" && historyMatch?.[1]) {
		sendJson(res, 200, await ledger.listHistory(decodeURIComponent(historyMatch[1])));
		return;
	}

	const settlementMatch = /^\/v1\/groups\/([^/]+)\/settlements$/.exec(path);
	if (method === "POST" && settlementMatch?.[1]) {
		const body = (await readJson(req)) as Record<string, unknown>;
		sendJson(
			res,
			200,
			await ledger.createSettlementIntent({
				...body,
				groupId: decodeURIComponent(settlementMatch[1]),
			} as CreateSettlementIntentInput),
		);
		return;
	}

	sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > 1024 * 1024) {
				req.destroy();
				reject(new Error("Request body too large"));
			}
		});
		req.on("end", () => {
			if (!body) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(body));
			} catch {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(data),
	});
	res.end(data);
}
