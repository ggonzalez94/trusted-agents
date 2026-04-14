import type { RouteHandler } from "../router.js";
import { asRecord } from "../validation.js";

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
	if (v.asset !== "native" && v.asset !== "usdc") return false;
	if (typeof v.amount !== "string" || v.amount.length === 0) return false;
	if (typeof v.chain !== "string" || v.chain.length === 0) return false;
	if (typeof v.toAddress !== "string" || !v.toAddress.startsWith("0x")) return false;
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
		if (!isTransferBody(body)) {
			throw new Error("transfers POST requires { asset, amount, chain, toAddress }");
		}
		return await executor(body);
	};
}
