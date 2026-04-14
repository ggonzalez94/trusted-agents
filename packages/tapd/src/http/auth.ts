import type { IncomingMessage } from "node:http";

export interface AuthContext {
	/** The transport the client connected through: "unix" requires no token, "tcp" does. */
	transport: "unix" | "tcp";
	expectedToken: string;
}

export function authorizeRequest(req: IncomingMessage, ctx: AuthContext): boolean {
	if (ctx.transport === "unix") {
		return true;
	}
	const header = req.headers.authorization;
	if (!header || typeof header !== "string") {
		return false;
	}
	const match = /^Bearer\s+(.+)$/i.exec(header);
	if (!match) {
		return false;
	}
	return constantTimeEqual(match[1].trim(), ctx.expectedToken);
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i += 1) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}
