import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	HermesTapIpcServer,
	sendHermesTapRequest,
} from "../src/hermes/ipc.js";

describe("Hermes TAP IPC", () => {
	const createdDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			createdDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
		);
	});

	it("round-trips JSON requests over the local socket", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "tap-hermes-ipc-"));
		createdDirs.push(stateDir);
		const socketPath = join(stateDir, "tap-hermes.sock");

		const server = new HermesTapIpcServer(socketPath, async (request) => {
			expect(request.method).toBe("ping");
			return { ok: true, result: { pong: true } };
		});
		await server.start();

		try {
			const response = await sendHermesTapRequest(socketPath, {
				method: "ping",
			});
			expect(response).toEqual({ pong: true });
		} finally {
			await server.stop();
		}
	});

	it("surfaces daemon-side errors with the original message", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "tap-hermes-ipc-"));
		createdDirs.push(stateDir);
		const socketPath = join(stateDir, "tap-hermes.sock");

		const server = new HermesTapIpcServer(socketPath, async () => {
			return {
				ok: false,
				error: {
					message: "boom",
					code: "TEST_ERROR",
				},
			};
		});
		await server.start();

		try {
			await expect(
				sendHermesTapRequest(socketPath, {
					method: "status",
				}),
			).rejects.toThrow("boom");
		} finally {
			await server.stop();
		}
	});

	it("consumes the processed line so later data does not replay the same request", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "tap-hermes-ipc-"));
		createdDirs.push(stateDir);
		const socketPath = join(stateDir, "tap-hermes.sock");
		let handled = 0;

		const server = new HermesTapIpcServer(socketPath, async (request) => {
			handled += 1;
			expect(request.method).toBe("ping");
			await new Promise((resolve) => setTimeout(resolve, 25));
			return { ok: true, result: { pong: true } };
		});
		await server.start();

		try {
			await new Promise<void>((resolve, reject) => {
				const client = net.createConnection(socketPath);
				let buffer = "";
				client.setEncoding("utf8");
				client.on("connect", () => {
					client.write('{"method":"ping"}\n');
					setTimeout(() => {
						client.write("ignored-extra-data");
					}, 5);
				});
				client.on("data", (chunk) => {
					buffer += chunk;
					if (!buffer.includes("\n")) {
						return;
					}
					client.end();
				});
				client.on("end", () => resolve());
				client.on("error", reject);
			});

			expect(handled).toBe(1);
		} finally {
			await server.stop();
		}
	});
});
