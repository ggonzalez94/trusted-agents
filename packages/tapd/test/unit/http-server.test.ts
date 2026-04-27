import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { socketFilePath } from "../../src/config.js";
import { Router } from "../../src/http/router.js";
import { TapdHttpServer } from "../../src/http/server.js";

function unixGet(
	socketPath: string,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ socketPath, method: "GET", path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
			);
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("TapdHttpServer", () => {
	let dataDir: string;
	let server: TapdHttpServer | null = null;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-http-test-"));
	});

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = null;
		}
		await rm(dataDir, { recursive: true, force: true });
	});

	it("starts and serves a simple route over TCP with a valid token", async () => {
		const router = new Router();
		router.add("GET", "/api/identity", async () => ({ agentId: 42 }));

		server = new TapdHttpServer({
			router,
			socketPath: socketFilePath(dataDir),
			tcpHost: "127.0.0.1",
			tcpPort: 0, // 0 = OS-assigned ephemeral port
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/identity`, {
			headers: { Authorization: "Bearer test-token-test-token-test-token" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ agentId: 42 });
	});

	it("rejects TCP requests without a token", async () => {
		const router = new Router();
		router.add("GET", "/api/identity", async () => ({ agentId: 42 }));

		server = new TapdHttpServer({
			router,
			socketPath: socketFilePath(dataDir),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/identity`);
		expect(response.status).toBe(401);
	});

	it("returns 404 for unknown routes", async () => {
		const router = new Router();
		server = new TapdHttpServer({
			router,
			socketPath: socketFilePath(dataDir),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/nope`, {
			headers: { Authorization: "Bearer test-token-test-token-test-token" },
		});
		expect(response.status).toBe(404);
	});

	it("accepts ?token=... query fallback for the SSE stream route", async () => {
		const router = new Router();
		server = new TapdHttpServer({
			router,
			socketPath: socketFilePath(dataDir),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
			sseHandler: (_req, res) => {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end("data: ok\n\n");
				return true;
			},
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(
			`http://127.0.0.1:${port}/api/events/stream?token=test-token-test-token-test-token`,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("data: ok");
	});

	it("rejects ?token=... on non-SSE routes (query fallback is scoped to /api/events/stream)", async () => {
		const router = new Router();
		router.add("GET", "/api/identity", async () => ({ agentId: 42 }));
		router.add("POST", "/daemon/shutdown", async () => ({ ok: true }));

		server = new TapdHttpServer({
			router,
			socketPath: socketFilePath(dataDir),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const getResponse = await fetch(
			`http://127.0.0.1:${port}/api/identity?token=test-token-test-token-test-token`,
		);
		expect(getResponse.status).toBe(401);

		const postResponse = await fetch(
			`http://127.0.0.1:${port}/daemon/shutdown?token=test-token-test-token-test-token`,
			{ method: "POST" },
		);
		expect(postResponse.status).toBe(401);
	});

	it("rejects ?token=... with the wrong value even on the SSE route", async () => {
		const router = new Router();
		server = new TapdHttpServer({
			router,
			socketPath: socketFilePath(dataDir),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
			sseHandler: (_req, res) => {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end("data: ok\n\n");
				return true;
			},
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/events/stream?token=wrong-token`);
		expect(response.status).toBe(401);
	});

	it("rejects unix-socket requests without a token", async () => {
		const router = new Router();
		router.add("GET", "/api/identity", async () => ({ agentId: 42 }));

		const socketPath = socketFilePath(dataDir);
		server = new TapdHttpServer({
			router,
			socketPath,
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const unauthenticated = await unixGet(socketPath, "/api/identity");
		expect(unauthenticated.status).toBe(401);

		const authenticated = await unixGet(socketPath, "/api/identity", {
			Authorization: "Bearer test-token-test-token-test-token",
		});
		expect(authenticated.status).toBe(200);
		expect(JSON.parse(authenticated.body)).toEqual({ agentId: 42 });
	});

	it("parses JSON body for POST requests", async () => {
		const router = new Router();
		router.add("POST", "/api/echo", async (_params, body) => ({ echoed: body }));

		server = new TapdHttpServer({
			router,
			socketPath: socketFilePath(dataDir),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/echo`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token-test-token-test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ hello: "world" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ echoed: { hello: "world" } });
	});
});
