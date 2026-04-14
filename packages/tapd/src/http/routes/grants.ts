import type {
	PermissionGrantSet,
	TapMessagingService,
	TapPublishGrantSetResult,
	TapRequestGrantSetResult,
} from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

interface GrantsBody {
	peer: string;
	grantSet: PermissionGrantSet;
	note?: string;
}

function isGrantsBody(value: unknown): value is GrantsBody {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.peer !== "string" || v.peer.length === 0) return false;
	if (!v.grantSet || typeof v.grantSet !== "object") return false;
	const gs = v.grantSet as Record<string, unknown>;
	if (!Array.isArray(gs.grants)) return false;
	if (v.note !== undefined && typeof v.note !== "string") return false;
	return true;
}

export interface GrantsRoutes {
	publish: RouteHandler<unknown, TapPublishGrantSetResult>;
	request: RouteHandler<unknown, TapRequestGrantSetResult>;
}

/**
 * POST /api/grants/publish — publish (or revoke) a grant set you give to a
 * peer. POST /api/grants/request — ask a peer to grant you a grant set.
 */
export function createGrantsRoutes(service: TapMessagingService): GrantsRoutes {
	return {
		publish: async (_params, body) => {
			if (!isGrantsBody(body)) {
				throw new Error("grants/publish requires { peer, grantSet, note? }");
			}
			return await service.publishGrantSet(body.peer, body.grantSet, body.note);
		},
		request: async (_params, body) => {
			if (!isGrantsBody(body)) {
				throw new Error("grants/request requires { peer, grantSet, note? }");
			}
			return await service.requestGrantSet(body.peer, body.grantSet, body.note);
		},
	};
}
