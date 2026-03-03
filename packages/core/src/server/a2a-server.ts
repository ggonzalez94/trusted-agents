import { Hono } from "hono";
import { RequestVerifier } from "../auth/verifier.js";
import { FilePendingInviteStore, type IPendingInviteStore } from "../connection/pending-invites.js";
import type { IAgentResolver } from "../identity/resolver.js";
import {
	CONNECTION_REVOKE,
	CONNECTION_UPDATE_SCOPE,
	MESSAGE_ACTION_REQUEST,
	MESSAGE_ACTION_RESPONSE,
} from "../protocol/methods.js";
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
		pendingInviteStore?: IPendingInviteStore;
		agentResolver?: IAgentResolver;
		resolveCacheTtlMs?: number;
		handlers?: Record<string, MethodHandler>;
	},
): Hono<ServerEnv> {
	const app = new Hono<ServerEnv>();

	const trustStore = options?.trustStore ?? new FileTrustStore(config.dataDir);
	const pendingInviteStore =
		options?.pendingInviteStore ?? new FilePendingInviteStore(config.dataDir);
	const verifier = new RequestVerifier({
		maxSignatureAgeSeconds: config.signatureMaxAgeSeconds,
		maxClockSkewSeconds: config.signatureClockSkewSeconds,
	});
	const handlers: Record<string, MethodHandler> = {
		...createBuiltInHandlers(trustStore),
		...(options?.handlers ?? {}),
	};

	const agentCard = generateAgentCard(config);

	// Public endpoint - no auth required
	app.get("/.well-known/agent-card.json", (c) => {
		return c.json(agentCard);
	});

	// A2A endpoint - auth required
	const authMiddleware = createAuthMiddleware(verifier, trustStore, {
		pendingInvites: pendingInviteStore,
		rateLimitPerMinute: config.rateLimitPerMinute,
		agentResolver: options?.agentResolver,
		resolveCacheTtlMs: options?.resolveCacheTtlMs,
	});
	const router = createRouter(handlers);

	app.post("/a2a", authMiddleware, async (c) => {
		const body = c.get("requestBody");
		const ctx = c.get("requestContext");
		const response = await router(body, ctx);
		return c.json(response);
	});

	return app;
}

function createBuiltInHandlers(trustStore: ITrustStore): Record<string, MethodHandler> {
	return {
		[CONNECTION_REVOKE]: async (params, ctx) => {
			const payload = (params ?? {}) as { connectionId?: unknown };
			const connectionId =
				typeof payload.connectionId === "string" ? payload.connectionId : ctx.contact?.connectionId;
			if (!connectionId) {
				throw new Error("connectionId is required");
			}
			await trustStore.updateContact(connectionId, { status: "revoked" });
			return { revoked: true, connectionId };
		},
		[CONNECTION_UPDATE_SCOPE]: async (params, ctx) => {
			const payload = (params ?? {}) as {
				connectionId?: unknown;
				permissions?: unknown;
			};
			const connectionId =
				typeof payload.connectionId === "string" ? payload.connectionId : ctx.contact?.connectionId;
			if (!connectionId) {
				throw new Error("connectionId is required");
			}
			if (
				typeof payload.permissions !== "object" ||
				payload.permissions === null ||
				Array.isArray(payload.permissions)
			) {
				throw new Error("permissions must be an object");
			}
			await trustStore.updateContact(connectionId, {
				permissions: payload.permissions as Record<string, boolean | Record<string, unknown>>,
			});
			return { updated: true, connectionId };
		},
		[MESSAGE_ACTION_REQUEST]: async () => ({ acknowledged: true }),
		[MESSAGE_ACTION_RESPONSE]: async () => ({ acknowledged: true }),
	};
}
