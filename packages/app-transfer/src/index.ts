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
}): Record<string, unknown> {
	return { type: "transfer/request", ...params };
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
