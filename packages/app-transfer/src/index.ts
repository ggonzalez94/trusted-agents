import { defineTapApp, generateActionId } from "trusted-agents-core";
import { handleTransferRequest } from "./handler.js";

export { handleTransferRequest } from "./handler.js";
export {
	parseTransferActionRequest,
	parseTransferActionResponse,
	buildTransferRequestText,
	buildTransferResponseText,
} from "trusted-agents-core";
export {
	findApplicableTransferGrants,
	matchesTransferGrantRequest,
} from "trusted-agents-core";
export type {
	TransferActionRequest,
	TransferActionResponse,
	TransferAsset,
} from "trusted-agents-core";

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
		actionId: params.actionId ?? generateActionId("txn"),
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
