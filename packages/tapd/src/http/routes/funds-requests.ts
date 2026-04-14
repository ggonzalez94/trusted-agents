import type {
	TapMessagingService,
	TapRequestFundsInput,
	TapRequestFundsResult,
} from "trusted-agents-core";
import type { RouteHandler } from "../router.js";
import { asRecord, requireBody } from "../validation.js";

function isFundsRequestBody(value: unknown): value is TapRequestFundsInput {
	const v = asRecord(value);
	if (!v) return false;
	if (typeof v.peer !== "string" || v.peer.length === 0) return false;
	if (v.asset !== "native" && v.asset !== "usdc") return false;
	if (typeof v.amount !== "string" || v.amount.length === 0) return false;
	if (typeof v.chain !== "string" || v.chain.length === 0) return false;
	if (typeof v.toAddress !== "string" || !v.toAddress.startsWith("0x")) return false;
	if (v.note !== undefined && typeof v.note !== "string") return false;
	return true;
}

/**
 * POST /api/funds-requests — send a `transfer/request` action to a connected
 * peer asking them to transfer assets to a specified address.
 */
export function createFundsRequestsRoute(
	service: TapMessagingService,
): RouteHandler<unknown, TapRequestFundsResult> {
	return async (_params, body) => {
		requireBody(
			body,
			isFundsRequestBody,
			"funds-requests POST requires { peer, asset, amount, chain, toAddress, note? }",
		);
		return await service.requestFunds(body);
	};
}
