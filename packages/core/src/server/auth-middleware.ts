import type { Context, Next } from "hono";
import type { HttpRequestComponents, IRequestVerifier } from "../auth/types.js";
import { isBootstrapMethod } from "../permissions/scopes.js";
import type { ITrustStore } from "../trust/trust-store.js";
import type { RequestContext, ServerEnv } from "./types.js";

export function createAuthMiddleware(verifier: IRequestVerifier, trustStore: ITrustStore) {
	return async (c: Context<ServerEnv>, next: Next) => {
		try {
			const clonedReq = c.req.raw.clone();
			const body = await clonedReq.text();

			const url = new URL(c.req.url);
			const headers: Record<string, string> = {};
			c.req.raw.headers.forEach((value, key) => {
				headers[key] = value;
			});

			const components: HttpRequestComponents = {
				method: c.req.method,
				url: url.pathname,
				headers,
				...(body ? { body } : {}),
			};

			const result = await verifier.verify(components);

			if (!result.valid || !result.signerAddress || !result.keyId) {
				return c.json({ error: "Forbidden" }, 403);
			}

			const contact = await trustStore.findByAgentAddress(result.signerAddress);

			// Determine if this is a bootstrap method by parsing the body
			let isBootstrap = false;
			if (body) {
				try {
					const parsed = JSON.parse(body);
					if (parsed && typeof parsed.method === "string") {
						isBootstrap = isBootstrapMethod(parsed.method);
					}
				} catch {
					// Not valid JSON; will be handled by the router
				}
			}

			if (!contact && !isBootstrap) {
				return c.json({ error: "Forbidden" }, 403);
			}

			const requestContext: RequestContext = {
				verifiedAddress: result.signerAddress,
				keyId: result.keyId,
				contact,
			};

			c.set("requestContext", requestContext);

			await next();
		} catch {
			return c.json({ error: "Forbidden" }, 403);
		}
	};
}
