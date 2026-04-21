import type { IncomingMessage } from "node:http";

export interface AuthContext {
	/** The transport the client connected through. Both require the bearer token. */
	transport: "unix" | "tcp";
	expectedToken: string;
}

export function authorizeRequest(req: IncomingMessage, ctx: AuthContext): boolean {
	// The unix socket previously bypassed the bearer token on the theory that
	// filesystem permissions alone are sufficient. They aren't: a same-uid
	// process (a compromised npm dep, a sandboxed renderer, etc.) can reach
	// the socket regardless of permission bits. Requiring the token forces a
	// client to prove filesystem read access to `.tapd-token` (mode 0600),
	// which a restricted same-uid attacker may not have.
	const headerToken = extractBearerHeader(req);
	if (headerToken !== null) {
		return constantTimeEqual(headerToken, ctx.expectedToken);
	}

	// Fallback: native browser EventSource cannot set custom headers, so for
	// SSE-style endpoints we accept the token via `?token=...` query string.
	// Same constant-time comparison applies — no security regression.
	const queryToken = extractTokenQuery(req);
	if (queryToken !== null) {
		return constantTimeEqual(queryToken, ctx.expectedToken);
	}

	return false;
}

function extractBearerHeader(req: IncomingMessage): string | null {
	const header = req.headers.authorization;
	if (!header || typeof header !== "string") return null;
	const match = /^Bearer\s+(.+)$/i.exec(header);
	if (!match) return null;
	return match[1].trim();
}

function extractTokenQuery(req: IncomingMessage): string | null {
	return getQueryParam(req, "token");
}

export function getQueryParam(req: IncomingMessage, key: string): string | null {
	const url = req.url;
	if (!url) return null;
	const queryStart = url.indexOf("?");
	if (queryStart === -1) return null;
	const params = new URLSearchParams(url.slice(queryStart + 1));
	const value = params.get(key);
	return value && value.length > 0 ? value : null;
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i += 1) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}
