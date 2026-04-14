import type { TapMessagingService } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

interface SendMessageBody {
	peer: string;
	text: string;
	scope?: string;
}

function isSendMessageBody(value: unknown): value is SendMessageBody {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.peer !== "string" || v.peer.length === 0) return false;
	if (typeof v.text !== "string") return false;
	if (v.scope !== undefined && typeof v.scope !== "string") return false;
	return true;
}

/**
 * POST /api/messages — send a TAP message to a connected peer through the
 * daemon's owned transport. Body shape: `{ peer, text, scope? }`.
 */
export function createMessagesRoute(service: TapMessagingService): RouteHandler {
	return async (_params, body) => {
		if (!isSendMessageBody(body)) {
			throw new Error("messages POST requires { peer: string, text: string, scope?: string }");
		}
		return await service.sendMessage(body.peer, body.text, body.scope);
	};
}
