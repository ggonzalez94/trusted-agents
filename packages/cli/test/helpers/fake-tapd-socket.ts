import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_TAPD_TOKEN = "fake-tapd-token-padding-padding-";

export interface FakeRequest {
	method: string;
	path: string;
	body: unknown;
	authHeader: string | undefined;
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
	closeAllSseClients(): void;
	stop(): Promise<void>;
}

export interface FakeTapdOptions {
	routes: FakeRoute[];
	/** Persist a `.tapd.port` file so callers exercising `discoverTapdUiUrl`
	 *  resolve a stable URL. */
	port?: number;
	/** When set, GET /api/events/stream returns an SSE stream that emits each
	 *  event subsequently passed to `publishSse`. */
	enableSse?: boolean;
}

/**
 * Spins up an HTTP server bound to a unique Unix socket inside a fresh temp
 * dir, and writes the bearer token (and optionally a `.tapd.port` file) the
 * CLI client expects to discover. Mirrors the production daemon's auth
 * boundary so tests can exercise `TapdClient` end-to-end without booting
 * the real `Daemon`.
 */
export async function startFakeTapd(options: FakeTapdOptions): Promise<FakeTapdHandle> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-fake-tapd-"));
	const socketPath = join(dataDir, ".tapd.sock");
	await writeFile(join(dataDir, ".tapd-token"), FAKE_TAPD_TOKEN, {
		encoding: "utf-8",
		mode: 0o600,
	});
	if (options.port !== undefined) {
		await writeFile(join(dataDir, ".tapd.port"), String(options.port), {
			encoding: "utf-8",
			mode: 0o600,
		});
	}
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
		closeAllSseClients(): void {
			for (const client of sseClients) {
				client.end();
			}
			sseClients.clear();
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
	const authHeader =
		typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;

	if (enableSse && method === "GET" && path === "/api/events/stream") {
		calls.push({ method, path, body: undefined, authHeader });
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
	calls.push({ method, path, body, authHeader });

	const route = routes.find((r) => r.method === method && matchPath(r.path, path));
	if (!route) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({ error: { code: "not_found", message: `no route ${method} ${path}` } }),
		);
		return;
	}

	try {
		const result = await route.handler({ method, path, body, authHeader });
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
