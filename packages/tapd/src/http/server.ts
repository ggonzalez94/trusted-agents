import { mkdir, rm } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { dirname, extname } from "node:path";
import { authorizeRequest } from "./auth.js";
import { sendError, sendJson, sendNotFound, sendUnauthorized } from "./response.js";
import type { Router } from "./router.js";
import { resolveStaticAsset } from "./static-assets.js";

export interface TapdHttpServerOptions {
	router: Router;
	socketPath: string;
	tcpHost: string;
	tcpPort: number;
	authToken: string;
	/** Optional hook for SSE upgrade — see Task 14. Returns true if handled. */
	sseHandler?: (req: IncomingMessage, res: ServerResponse, transport: "unix" | "tcp") => boolean;
	/**
	 * Directory containing the bundled UI's static export. When set, GET
	 * requests for non-API paths attempt to serve files from here before
	 * falling through to the route dispatcher.
	 */
	staticAssetsDir?: string;
}

interface BoundServer {
	server: Server;
	transport: "unix" | "tcp";
}

export class TapdHttpServer {
	private readonly router: Router;
	private readonly socketPath: string;
	private readonly tcpHost: string;
	private readonly tcpPort: number;
	private readonly authToken: string;
	private readonly sseHandler?: TapdHttpServerOptions["sseHandler"];
	private readonly staticAssetsDir?: string;

	private bound: BoundServer[] = [];
	private actualTcpPort = 0;

	constructor(options: TapdHttpServerOptions) {
		this.router = options.router;
		this.socketPath = options.socketPath;
		this.tcpHost = options.tcpHost;
		this.tcpPort = options.tcpPort;
		this.authToken = options.authToken;
		this.sseHandler = options.sseHandler;
		this.staticAssetsDir = options.staticAssetsDir;
	}

	async start(): Promise<void> {
		await this.bindUnix();
		await this.bindTcp();
	}

	async stop(): Promise<void> {
		await Promise.all(
			this.bound.map(
				({ server }) =>
					new Promise<void>((resolve) => {
						// Force-close any in-flight connections (e.g., long-lived SSE
						// streams) so server.close() can resolve. Without this, an open
						// SSE connection holds the server open forever.
						server.closeAllConnections?.();
						server.close(() => resolve());
					}),
			),
		);
		this.bound = [];
		await rm(this.socketPath, { force: true }).catch(() => {});
	}

	boundTcpPort(): number {
		return this.actualTcpPort;
	}

	private async bindUnix(): Promise<void> {
		await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
		await rm(this.socketPath, { force: true }).catch(() => {});

		const server = createServer((req, res) => this.handle(req, res, "unix"));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.bound.push({ server, transport: "unix" });
	}

	private async bindTcp(): Promise<void> {
		const server = createServer((req, res) => this.handle(req, res, "tcp"));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.tcpPort, this.tcpHost, () => {
				const address = server.address();
				if (address && typeof address === "object") {
					this.actualTcpPort = address.port;
				}
				server.off("error", reject);
				resolve();
			});
		});
		this.bound.push({ server, transport: "tcp" });
	}

	private handle(req: IncomingMessage, res: ServerResponse, transport: "unix" | "tcp"): void {
		void this.handleAsync(req, res, transport).catch((error) => {
			sendError(res, 500, "internal_error", error instanceof Error ? error.message : "unknown");
		});
	}

	private async handleAsync(
		req: IncomingMessage,
		res: ServerResponse,
		transport: "unix" | "tcp",
	): Promise<void> {
		if (!authorizeRequest(req, { transport, expectedToken: this.authToken })) {
			sendUnauthorized(res);
			return;
		}

		if (this.sseHandler?.(req, res, transport)) {
			return;
		}

		const method = req.method ?? "GET";
		const url = req.url ?? "/";
		const path = url.split("?")[0];

		let body: unknown;
		if (method !== "GET" && method !== "HEAD") {
			body = await readJsonBody(req);
		}

		const result = await this.router.dispatch(method, path, body);
		if (result !== null) {
			sendJson(res, 200, result);
			return;
		}

		// Route did not match. For GET requests we attempt to serve the bundled
		// UI's static export. The UI is served at /, /_next/*, and any other
		// non-API path; failing both the router and the static lookup falls
		// through to a 404.
		if (
			method === "GET" &&
			this.staticAssetsDir &&
			!path.startsWith("/api/") &&
			!path.startsWith("/daemon/")
		) {
			const asset = await resolveStaticAsset(this.staticAssetsDir, path);
			if (asset) {
				res.writeHead(200, {
					"Content-Type": asset.contentType,
					"Content-Length": asset.body.length,
					"Cache-Control": "no-store",
				});
				res.end(asset.body);
				return;
			}
			// SPA fallback: serve index.html for client-routed paths so the
			// React app can resolve its own routes. Skip files with extensions
			// (those are real misses) to keep 404s honest for missing assets.
			if (!extname(path)) {
				const index = await resolveStaticAsset(this.staticAssetsDir, "/");
				if (index) {
					res.writeHead(200, {
						"Content-Type": index.contentType,
						"Content-Length": index.body.length,
						"Cache-Control": "no-store",
					});
					res.end(index.body);
					return;
				}
			}
		}

		sendNotFound(res);
	}
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk: string) => {
			raw += chunk;
			if (raw.length > 1024 * 1024) {
				req.destroy();
				reject(new Error("request body too large"));
			}
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
