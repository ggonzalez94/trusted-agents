import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ExpenseServerError, badRequest, unauthenticated } from "./errors.js";
import type { ExpenseLedger } from "./ledger.js";
import {
	parseCreateGroupInput,
	parseCreateSettlementIntentInput,
	parseLogExpenseInput,
} from "./validation.js";

export interface ExpenseHttpServer {
	listen(options: { host: string; port: number }): Promise<string>;
	stop(): Promise<void>;
}

export function createExpenseHttpServer(options: {
	ledger: ExpenseLedger;
	apiToken?: string;
}): ExpenseHttpServer {
	const server = createServer((req, res) => {
		void route(options.ledger, options.apiToken, req, res).catch((error: unknown) => {
			const normalized = normalizeError(error);
			sendJson(res, normalized.status, {
				error: { code: normalized.code, message: normalized.message },
			});
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
			const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
			return `http://${displayHost}:${address.port}`;
		},
		stop: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

async function route(
	ledger: ExpenseLedger,
	apiToken: string | undefined,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const method = req.method ?? "GET";
	const path = new URL(req.url ?? "/", "http://localhost").pathname;

	if (method === "GET" && path === "/health") {
		sendJson(res, 200, { status: "ok" });
		return;
	}

	authorize(req, apiToken);

	if (method === "POST" && path === "/v1/groups") {
		sendJson(res, 200, await ledger.createGroup(parseCreateGroupInput(await readJson(req))));
		return;
	}

	if (method === "POST" && path === "/v1/expenses") {
		sendJson(res, 200, await ledger.logExpense(parseLogExpenseInput(await readJson(req))));
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
		sendJson(
			res,
			200,
			await ledger.createSettlementIntent(
				parseCreateSettlementIntentInput(
					decodeURIComponent(settlementMatch[1]),
					await readJson(req),
				),
			),
		);
		return;
	}

	sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
}

function authorize(req: IncomingMessage, apiToken: string | undefined): void {
	if (!apiToken) {
		return;
	}
	const authorization = req.headers.authorization;
	const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
	if (!constantTimeEqual(token, apiToken)) {
		throw unauthenticated();
	}
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > 1024 * 1024) {
				req.destroy();
				reject(badRequest("Request body too large"));
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
				reject(badRequest("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

function constantTimeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeError(error: unknown): ExpenseServerError {
	if (error instanceof ExpenseServerError) {
		return error;
	}
	return new ExpenseServerError(500, "INTERNAL_ERROR", "Internal server error");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(data),
	});
	res.end(data);
}
