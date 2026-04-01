export type TransferAsset = "native" | "usdc";

export interface TransferActionRequest extends Record<string, unknown> {
	type: "transfer/request";
	actionId: string;
	asset: TransferAsset;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
}

export interface TransferActionResponse extends Record<string, unknown> {
	type: "transfer/response";
	requestId?: string;
	actionId: string;
	asset: TransferAsset;
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	status: "completed" | "rejected" | "failed";
	txHash?: `0x${string}`;
	error?: string;
}
