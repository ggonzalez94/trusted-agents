import type { Context, Next } from "hono";
import type { HttpRequestComponents, IRequestVerifier } from "../auth/types.js";
import { caip2ToChainId, nowISO } from "../common/index.js";
import type { IAgentResolver } from "../identity/resolver.js";
import { isBootstrapMethod } from "../permissions/scopes.js";
import { createJsonRpcError, forbidden } from "../protocol/index.js";
import type { JsonRpcId } from "../protocol/types.js";
import type { ITrustStore } from "../trust/trust-store.js";
import type { Contact } from "../trust/types.js";
import type { RequestContext, ServerEnv } from "./types.js";

interface PendingInviteRedeemer {
	redeem(nonce: string): Promise<boolean> | boolean;
}

interface AuthMiddlewareOptions {
	pendingInvites?: PendingInviteRedeemer;
	rateLimitPerMinute?: number;
	agentResolver?: IAgentResolver;
	resolveCacheTtlMs?: number;
}

interface RateLimitWindow {
	windowStart: number;
	count: number;
}

function getMethodFromBody(body: string): string | null {
	if (body.length === 0) {
		return null;
	}
	try {
		const parsed = JSON.parse(body) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			"method" in parsed &&
			typeof (parsed as { method: unknown }).method === "string"
		) {
			return (parsed as { method: string }).method;
		}
		return null;
	} catch {
		return null;
	}
}

function extractNonceFromConnectionRequest(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as {
			method?: unknown;
			params?: { nonce?: unknown };
		};
		if (parsed?.method !== "connection/request") {
			return null;
		}
		return typeof parsed.params?.nonce === "string" ? parsed.params.nonce : null;
	} catch {
		return null;
	}
}

function extractConnectionId(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as {
			params?: { message?: { metadata?: { trustedAgent?: { connectionId?: unknown } } } };
		};
		const value = parsed.params?.message?.metadata?.trustedAgent?.connectionId;
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function isActive(contact: Contact | null): contact is Contact {
	return contact !== null && contact.status === "active";
}

function extractRequestId(body: string): JsonRpcId {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("id" in parsed)) {
			return null;
		}

		const id = (parsed as { id: unknown }).id;
		if (typeof id === "string" || typeof id === "number" || id === null) {
			return id;
		}
		return null;
	} catch {
		return null;
	}
}

function respondJsonRpcError(
	c: Context<ServerEnv>,
	body: string,
	status: 401 | 403 | 429,
	code: number,
	message: string,
) {
	const id = extractRequestId(body);
	return c.json(createJsonRpcError(id, { code, message }), status);
}

export function createAuthMiddleware(
	verifier: IRequestVerifier,
	trustStore: ITrustStore,
	options: AuthMiddlewareOptions = {},
) {
	const rateLimitPerMinute = options.rateLimitPerMinute ?? 60;
	const rateLimiter = new Map<string, RateLimitWindow>();

	return async (c: Context<ServerEnv>, next: Next) => {
		try {
			const clonedReq = c.req.raw.clone();
			const body = await clonedReq.text();
			const method = getMethodFromBody(body);

			const headers: Record<string, string> = {};
			c.req.raw.headers.forEach((value, key) => {
				headers[key] = value;
			});

			const hasBody = c.req.raw.body !== null;
			const components: HttpRequestComponents = {
				method: c.req.method,
				url: c.req.url,
				headers,
				...(hasBody ? { body } : {}),
			};

			const result = await verifier.verify(components);

			if (!result.valid || !result.signerAddress || !result.keyId) {
				return respondJsonRpcError(c, body, 403, forbidden().code, forbidden().message);
			}

			let matchedChain: string | undefined;
			if (result.keyIdChainId) {
				matchedChain = `eip155:${result.keyIdChainId}`;
			}

			let contact = await trustStore.findByAgentAddress(result.signerAddress, matchedChain);
			if (!contact && options.agentResolver && method && !isBootstrapMethod(method)) {
				const connectionId = extractConnectionId(body);
				if (connectionId) {
					const existing = await trustStore.getContact(connectionId);
					if (existing && existing.status !== "revoked") {
						const resolved = await options.agentResolver.resolveWithCache(
							existing.peerAgentId,
							existing.peerChain,
							options.resolveCacheTtlMs ?? 86_400_000,
						);
						if (resolved.agentAddress.toLowerCase() === result.signerAddress.toLowerCase()) {
							if (existing.peerAgentAddress.toLowerCase() !== resolved.agentAddress.toLowerCase()) {
								await trustStore.updateContact(existing.connectionId, {
									peerAgentAddress: resolved.agentAddress,
								});
							}
							contact = { ...existing, peerAgentAddress: resolved.agentAddress };
						}
					}
				}
			}
			const bootstrapMethod = method !== null && isBootstrapMethod(method);

			if (!contact && !bootstrapMethod) {
				return respondJsonRpcError(c, body, 403, forbidden().code, forbidden().message);
			}

			if (contact && contact.status === "revoked") {
				return respondJsonRpcError(c, body, 403, forbidden().code, forbidden().message);
			}

			if (!bootstrapMethod && !isActive(contact)) {
				return respondJsonRpcError(c, body, 403, forbidden().code, forbidden().message);
			}

			if (contact && result.keyIdChainId) {
				const contactChainId = caip2ToChainId(contact.peerChain);
				if (contactChainId !== null && contactChainId !== result.keyIdChainId) {
					return respondJsonRpcError(c, body, 403, forbidden().code, forbidden().message);
				}
			}

			if (!contact && method === "connection/request") {
				const nonce = extractNonceFromConnectionRequest(body);
				if (!nonce || !options.pendingInvites) {
					return respondJsonRpcError(c, body, 403, forbidden().code, forbidden().message);
				}
				const redeemed = await Promise.resolve(options.pendingInvites.redeem(nonce));
				if (!redeemed) {
					return respondJsonRpcError(c, body, 403, forbidden().code, forbidden().message);
				}
			}

			if (!contact && bootstrapMethod && method !== "connection/request") {
				return respondJsonRpcError(c, body, 403, forbidden().code, forbidden().message);
			}

			const now = Date.now();
			const rateLimitKey = contact?.connectionId ?? `${result.keyId}:${result.signerAddress}`;
			const windowStart = now - (now % 60_000);
			const window = rateLimiter.get(rateLimitKey);
			if (!window || window.windowStart !== windowStart) {
				rateLimiter.set(rateLimitKey, { windowStart, count: 1 });
			} else {
				window.count += 1;
				if (window.count > rateLimitPerMinute) {
					return respondJsonRpcError(c, body, 429, 429, "Too Many Requests");
				}
			}

			if (contact) {
				const lastContactAt = nowISO();
				await trustStore.updateContact(contact.connectionId, { lastContactAt });
				contact = { ...contact, lastContactAt };
			}

			const requestContext: RequestContext = {
				verifiedAddress: result.signerAddress,
				keyId: result.keyId,
				contact,
			};

			c.set("requestContext", requestContext);
			c.set("requestBody", body);
			c.set("requestMethod", method ?? undefined);

			await next();
		} catch {
			return respondJsonRpcError(c, "", 403, forbidden().code, forbidden().message);
		}
	};
}
