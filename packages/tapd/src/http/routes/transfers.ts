import type { RouteHandler } from "../router.js";
import {
	asRecord,
	isNonEmptyString,
	isTapTransferAsset,
	isZeroXPrefixedString,
	requireBody,
} from "../validation.js";

export interface TransferExecutionRequest {
	asset: "native" | "usdc";
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
}

export interface TransferExecutionResult {
	txHash: `0x${string}`;
}

export type TransferExecutor = (
	request: TransferExecutionRequest,
) => Promise<TransferExecutionResult>;

function isTransferBody(value: unknown): value is TransferExecutionRequest {
	const v = asRecord(value);
	if (!v) return false;
	if (!isTapTransferAsset(v.asset)) return false;
	if (!isNonEmptyString(v.amount)) return false;
	if (!isNonEmptyString(v.chain)) return false;
	if (!isZeroXPrefixedString(v.toAddress)) return false;
	return true;
}

/**
 * POST /api/transfers — execute an on-chain transfer using the daemon's
 * configured signing provider. Mirrors the existing `tap transfer` CLI
 * command: validates inputs, delegates the actual broadcast to the host's
 * `executeTransfer` adapter, returns `{ txHash }`.
 */
export function createTransfersRoute(
	executor: TransferExecutor,
): RouteHandler<unknown, TransferExecutionResult> {
	return async (_params, body) => {
		requireBody(
			body,
			isTransferBody,
			"transfers POST requires { asset, amount, chain, toAddress }",
		);
		return await executor(body);
	};
}
