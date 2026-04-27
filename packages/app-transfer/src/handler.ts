import type { TapActionContext, TapActionResult, TransferActionRequest } from "trusted-agents-core";
import {
	createGrantSet,
	findApplicableTransferGrants,
	parseTransferActionPayload,
	toErrorMessage,
} from "trusted-agents-core";

export async function handleTransferRequest(ctx: TapActionContext): Promise<TapActionResult> {
	const request = validatePayload(ctx.payload);
	if (!request) {
		return {
			success: false,
			error: {
				code: "INVALID_PAYLOAD",
				message:
					"Missing or invalid transfer/request fields: asset, amount, chain, toAddress, actionId",
			},
		};
	}

	// Check if grants cover this transfer
	const matchingGrants = findApplicableTransferGrants(
		createGrantSet(ctx.peer.grantsToPeer, ""),
		request,
	);

	if (matchingGrants.length === 0) {
		ctx.events.emit({
			type: "transfer/rejected",
			summary: `No matching grant for transfer of ${request.amount} ${request.asset} on ${request.chain}`,
			data: { actionId: request.actionId, asset: request.asset, amount: request.amount },
		});

		return {
			success: false,
			data: {
				type: "transfer/response",
				actionId: request.actionId,
				asset: request.asset,
				amount: request.amount,
				chain: request.chain,
				toAddress: request.toAddress,
				status: "rejected",
			},
			error: {
				code: "NO_MATCHING_GRANT",
				message: "No active transfer grant covers this request",
			},
		};
	}

	// Execute the transfer
	try {
		const result = await ctx.payments.execute({
			asset: request.asset,
			amount: request.amount,
			chain: request.chain,
			toAddress: request.toAddress,
			note: request.note,
		});

		const assetLabel = request.asset === "native" ? "ETH" : "USDC";
		await ctx.log.append({
			text: `Transferred ${request.amount} ${assetLabel} on ${request.chain} to ${request.toAddress} (tx: ${result.txHash})`,
			direction: "outbound",
		});

		ctx.events.emit({
			type: "transfer/completed",
			summary: `Transferred ${request.amount} ${assetLabel} on ${request.chain} to ${request.toAddress}`,
			data: {
				actionId: request.actionId,
				asset: request.asset,
				amount: request.amount,
				txHash: result.txHash,
			},
		});

		return {
			success: true,
			data: {
				type: "transfer/response",
				actionId: request.actionId,
				asset: request.asset,
				amount: request.amount,
				chain: request.chain,
				toAddress: request.toAddress,
				status: "completed",
				txHash: result.txHash,
			},
		};
	} catch (error: unknown) {
		const errorMessage = toErrorMessage(error);

		ctx.events.emit({
			type: "transfer/failed",
			summary: `Transfer failed: ${errorMessage}`,
			data: { actionId: request.actionId, asset: request.asset, amount: request.amount },
		});

		return {
			success: false,
			data: {
				type: "transfer/response",
				actionId: request.actionId,
				asset: request.asset,
				amount: request.amount,
				chain: request.chain,
				toAddress: request.toAddress,
				status: "failed",
			},
			error: {
				code: "TRANSFER_FAILED",
				message: errorMessage,
			},
		};
	}
}

function validatePayload(payload: Record<string, unknown>): TransferActionRequest | null {
	return parseTransferActionPayload(payload);
}
