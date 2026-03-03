import { Hono } from "hono";
import { RequestVerifier } from "../auth/verifier.js";
import { FileTrustStore } from "../trust/file-trust-store.js";
import type { ITrustStore } from "../trust/trust-store.js";
import { generateAgentCard } from "./agent-card.js";
import { createAuthMiddleware } from "./auth-middleware.js";
import { createRouter } from "./router.js";
import type { MethodHandler, ServerConfig, ServerEnv } from "./types.js";

export function createA2AServer(
	config: ServerConfig,
	options?: {
		trustStore?: ITrustStore;
		handlers?: Record<string, MethodHandler>;
	},
): Hono<ServerEnv> {
	const app = new Hono<ServerEnv>();

	const trustStore = options?.trustStore ?? new FileTrustStore(config.dataDir);
	const verifier = new RequestVerifier();
	const handlers = options?.handlers ?? {};

	const agentCard = generateAgentCard(config);

	// Public endpoint - no auth required
	app.get("/.well-known/agent-card.json", (c) => {
		return c.json(agentCard);
	});

	// A2A endpoint - auth required
	const authMiddleware = createAuthMiddleware(verifier, trustStore);
	const router = createRouter(handlers);

	app.post("/a2a", authMiddleware, async (c) => {
		const body = await c.req.raw.clone().text();
		const ctx = c.get("requestContext");
		const response = await router(body, ctx);
		return c.json(response);
	});

	return app;
}
