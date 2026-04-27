import type { TapConnectResult, TapMessagingService } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";
import { asRecord, isNonEmptyString, isOptionalNumber, requireBody } from "../validation.js";

interface ConnectBody {
	inviteUrl: string;
	waitMs?: number;
}

function isConnectBody(value: unknown): value is ConnectBody {
	const v = asRecord(value);
	if (!v) return false;
	if (!isNonEmptyString(v.inviteUrl)) return false;
	if (!isOptionalNumber(v.waitMs)) return false;
	return true;
}

/**
 * POST /api/connect — accept an invite URL and run the TAP handshake. The
 * daemon's single-process owner blocks until the result is `active` or the
 * caller-provided `waitMs` budget elapses.
 */
export function createConnectRoute(
	service: TapMessagingService,
): RouteHandler<unknown, TapConnectResult> {
	return async (_params, body) => {
		requireBody(
			body,
			isConnectBody,
			"connect POST requires { inviteUrl: string, waitMs?: number }",
		);
		return await service.connect({ inviteUrl: body.inviteUrl, waitMs: body.waitMs });
	};
}
