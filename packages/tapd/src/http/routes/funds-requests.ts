import type {
	TapMessagingService,
	TapRequestFundsInput,
	TapRequestFundsResult,
} from "trusted-agents-core";
import type { RouteHandler } from "../router.js";
import {
	asRecord,
	hasTapTransferFields,
	isNonEmptyString,
	isOptionalString,
	requireBody,
} from "../validation.js";

function isFundsRequestBody(value: unknown): value is TapRequestFundsInput {
	const v = asRecord(value);
	if (!v) return false;
	if (!isNonEmptyString(v.peer)) return false;
	if (!hasTapTransferFields(v)) return false;
	if (!isOptionalString(v.note)) return false;
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
