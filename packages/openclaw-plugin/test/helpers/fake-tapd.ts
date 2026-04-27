import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketFilePath, tokenFilePath } from "trusted-agents-tapd";

export const FAKE_TAPD_TOKEN = "fake-tapd-token-padding-padding-";

export interface FakeRequest {
	method: string;
	path: string;
	body: unknown;
}

export type FakeHandler = (req: FakeRequest) => unknown | Promise<unknown>;

export interface FakeRoute {
	method: string;
	path: string;
	handler: FakeHandler;
}

export interface SseEvent {
	id: string;
	type: string;
	data: unknown;
}

export interface FakeTapdHandle {
	socketPath: string;
	dataDir: string;
	calls: FakeRequest[];
	publishSse(event: SseEvent): void;
	stop(): Promise<void>;
}

export interface FakeTapdOptions {
	routes: FakeRoute[];
	/** When set, GET /api/events/stream returns an SSE stream that emits each
	 *  event subsequently passed to `publishSse`. */
	enableSse?: boolean;
}

/**
 * Spins up an in-memory HTTP server bound to a unique Unix socket inside a
 * fresh temp dir. Serves a tiny set of programmable routes so the tests can
 * exercise the OpenClaw tapd client without booting the real daemon.
 */
export async function startFakeTapd(options: FakeTapdOptions): Promise<FakeTapdHandle> {
	const dataDir = await mkdtemp(join(tmpdir(), "openclaw-tapd-"));
	const socketPath = socketFilePath(dataDir);
	// Persist a fake bearer token alongside the socket. The real tapd writes
	// one at start-time; the OpenClaw client now reads it per-request and
	// sends it as `Authorization: Bearer`. Without this, every client call
	// would fail at the token-load step before reaching the fake server.
	await writeFile(tokenFilePath(dataDir), FAKE_TAPD_TOKEN, {
		encoding: "utf-8",
		mode: 0o600,
	});
	const calls: FakeRequest[] = [];
	const sseClients = new Set<ServerResponse>();

	const server: Server = createServer((req, res) => {
		void handle(req, res, options.routes, calls, sseClients, Boolean(options.enableSse)).catch(
			(error: unknown) => {
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								code: "internal",
								message: error instanceof Error ? error.message : String(error),
							},
						}),
					);
				}
			},
		);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return {
		socketPath,
		dataDir,
		calls,
		publishSse(event: SseEvent): void {
			for (const client of sseClients) {
				client.write(`id: ${event.id}\n`);
				client.write(`event: ${event.type}\n`);
				client.write(`data: ${JSON.stringify(event.data)}\n\n`);
			}
		},
		stop: async () => {
			for (const client of sseClients) {
				client.end();
			}
			sseClients.clear();
			await new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			});
			await rm(dataDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}

async function handle(
	req: IncomingMessage,
	res: ServerResponse,
	routes: FakeRoute[],
	calls: FakeRequest[],
	sseClients: Set<ServerResponse>,
	enableSse: boolean,
): Promise<void> {
	const method = req.method ?? "GET";
	const rawUrl = req.url ?? "/";
	const path = rawUrl.split("?")[0];

	if (enableSse && method === "GET" && path === "/api/events/stream") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-store",
			Connection: "keep-alive",
		});
		res.write(": fake tapd sse stream ready\n\n");
		sseClients.add(res);
		req.on("close", () => {
			sseClients.delete(res);
		});
		return;
	}

	const body = method === "GET" || method === "HEAD" ? undefined : await readJsonBody(req);
	calls.push({ method, path, body });

	const route = routes.find((r) => r.method === method && matchPath(r.path, path));
	if (!route) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({ error: { code: "not_found", message: `no route ${method} ${path}` } }),
		);
		return;
	}

	try {
		const result = await route.handler({ method, path, body });
		if (result instanceof FakeError) {
			res.writeHead(result.status, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { code: result.code, message: result.message } }));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(result ?? {}));
	} catch (error: unknown) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				error: {
					code: "internal",
					message: error instanceof Error ? error.message : String(error),
				},
			}),
		);
	}
}

function matchPath(pattern: string, actual: string): boolean {
	const patternParts = pattern.split("/");
	const actualParts = actual.split("/");
	if (patternParts.length !== actualParts.length) return false;
	for (let i = 0; i < patternParts.length; i += 1) {
		const p = patternParts[i];
		const a = actualParts[i];
		if (p.startsWith(":")) continue;
		if (p !== a) return false;
	}
	return true;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk: string) => {
			raw += chunk;
		});
		req.on("end", () => {
			if (raw.length === 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

/** Sentinel return type for handlers that want to emit a non-200 error. */
export class FakeError {
	constructor(
		public readonly status: number,
		public readonly code: string,
		public readonly message: string,
	) {}
}
