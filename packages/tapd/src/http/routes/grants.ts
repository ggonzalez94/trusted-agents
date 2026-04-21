import type {
	PermissionGrantSet,
	TapMessagingService,
	TapPublishGrantSetResult,
	TapRequestGrantSetResult,
} from "trusted-agents-core";
import type { RouteHandler } from "../router.js";
import { asRecord, isNonEmptyString, isOptionalString, requireBody } from "../validation.js";

interface GrantsBody {
	peer: string;
	grantSet: PermissionGrantSet;
	note?: string;
}

function isGrantsBody(value: unknown): value is GrantsBody {
	const v = asRecord(value);
	if (!v) return false;
	if (!isNonEmptyString(v.peer)) return false;
	if (!v.grantSet || typeof v.grantSet !== "object") return false;
	const gs = v.grantSet as Record<string, unknown>;
	if (!Array.isArray(gs.grants)) return false;
	if (!isOptionalString(v.note)) return false;
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
			requireBody(body, isGrantsBody, "grants/publish requires { peer, grantSet, note? }");
			return await service.publishGrantSet(body.peer, body.grantSet, body.note);
		},
		request: async (_params, body) => {
			requireBody(body, isGrantsBody, "grants/request requires { peer, grantSet, note? }");
			return await service.requestGrantSet(body.peer, body.grantSet, body.note);
		},
	};
}
