import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
			socketPath: join(dataDir, ".tapd.sock"),
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
			socketPath: join(dataDir, ".tapd.sock"),
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
			socketPath: join(dataDir, ".tapd.sock"),
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

	it("accepts ?token=... query fallback when no Authorization header is set", async () => {
		const router = new Router();
		router.add("GET", "/api/identity", async () => ({ agentId: 42 }));

		server = new TapdHttpServer({
			router,
			socketPath: join(dataDir, ".tapd.sock"),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(
			`http://127.0.0.1:${port}/api/identity?token=test-token-test-token-test-token`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ agentId: 42 });
	});

	it("rejects requests with the wrong token in the query", async () => {
		const router = new Router();
		router.add("GET", "/api/identity", async () => ({ agentId: 42 }));

		server = new TapdHttpServer({
			router,
			socketPath: join(dataDir, ".tapd.sock"),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/identity?token=wrong-token`);
		expect(response.status).toBe(401);
	});

	it("rejects unix-socket requests without a token", async () => {
		const router = new Router();
		router.add("GET", "/api/identity", async () => ({ agentId: 42 }));

		const socketPath = join(dataDir, ".tapd.sock");
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
			socketPath: join(dataDir, ".tapd.sock"),
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
