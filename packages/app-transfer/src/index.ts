import { defineTapApp } from "trusted-agents-core";
import { handleTransferRequest } from "./handler.js";

export { handleTransferRequest } from "./handler.js";
export {
	parseTransferActionRequest,
	parseTransferActionResponse,
	buildTransferRequestText,
	buildTransferResponseText,
} from "./parser.js";
export {
	findApplicableTransferGrants,
	matchesTransferGrantRequest,
} from "./grants.js";
export type {
	TransferActionRequest,
	TransferActionResponse,
	TransferAsset,
} from "./types.js";

export function buildTransferPayload(params: {
	asset: string;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
	actionId?: string;
}): Record<string, unknown> {
	return {
		type: "transfer/request",
		actionId: params.actionId ?? `txn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
		...params,
	};
}

export const transferApp = defineTapApp({
	id: "transfer",
	name: "Transfer",
	version: "1.0.0",
	actions: {
		"transfer/request": { handler: handleTransferRequest },
	},
	grantScopes: ["transfer/request"],
});

export default transferApp;
