import net from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface HermesTapRequest {
	method: string;
	params?: Record<string, unknown>;
}

export interface HermesTapError {
	message: string;
	code?: string;
}

export type HermesTapResponse =
	| { ok: true; result: unknown }
	| { ok: false; error: HermesTapError };

type HermesTapHandler = (request: HermesTapRequest) => Promise<HermesTapResponse>;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class HermesTapIpcServer {
	private server: net.Server | null = null;

	constructor(
		private readonly socketPath: string,
		private readonly handler: HermesTapHandler,
	) {}

	async start(): Promise<void> {
		if (this.server) {
			return;
		}

		await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
		await rm(this.socketPath, { force: true }).catch(() => {});

		this.server = net.createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				buffer += chunk;
				const newlineIndex = buffer.indexOf("\n");
				if (newlineIndex === -1) {
					return;
				}
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				void this.respond(socket, line);
			});
			socket.on("error", () => {
				socket.destroy();
			});
		});

		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(this.socketPath, () => {
				this.server?.off("error", reject);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
		await rm(this.socketPath, { force: true }).catch(() => {});
	}

	private async respond(socket: net.Socket, line: string): Promise<void> {
		const response = await this.handleLine(line);
		socket.end(`${JSON.stringify(response)}\n`);
	}

	private async handleLine(line: string): Promise<HermesTapResponse> {
		try {
			const request = JSON.parse(line) as HermesTapRequest;
			if (typeof request.method !== "string" || request.method.trim().length === 0) {
				return {
					ok: false,
					error: {
						code: "INVALID_REQUEST",
						message: "IPC request is missing a valid method",
					},
				};
			}
			return await this.handler(request);
		} catch (error: unknown) {
			return {
				ok: false,
				error: {
					code: "INVALID_REQUEST",
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}
}

export async function sendHermesTapRequest(
	socketPath: string,
	request: HermesTapRequest,
	timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
	return await new Promise<unknown>((resolve, reject) => {
		const client = net.createConnection(socketPath);
		let buffer = "";
		let settled = false;

		const finish = (error?: Error, result?: unknown) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			client.destroy();
			if (error) {
				reject(error);
				return;
			}
			resolve(result);
		};

		const timer = setTimeout(() => {
			finish(new Error(`Timed out waiting for Hermes TAP daemon response from ${socketPath}`));
		}, timeoutMs);

		client.setEncoding("utf8");
		client.on("connect", () => {
			client.write(`${JSON.stringify(request)}\n`);
		});
		client.on("data", (chunk) => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}
			try {
				const response = JSON.parse(buffer.slice(0, newlineIndex).trim()) as HermesTapResponse;
				if (!response.ok) {
					finish(new Error(response.error.message));
					return;
				}
				finish(undefined, response.result);
			} catch (error: unknown) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		client.on("error", (error) => {
			finish(error);
		});
		client.on("end", () => {
			if (!settled && buffer.trim().length === 0) {
				finish(new Error("Hermes TAP daemon closed the connection without a response"));
			}
		});
	});
}
