import { findActiveGrantsByScope, getUsdcAsset } from "trusted-agents-core";
import type { PermissionGrant, PermissionGrantSet } from "trusted-agents-core";
import { parseEther, parseUnits } from "viem";
import type { TransferActionRequest } from "./types.js";

export function findApplicableTransferGrants(
	grantSet: PermissionGrantSet,
	request: TransferActionRequest,
): PermissionGrant[] {
	return findActiveGrantsByScope(grantSet, "transfer/request").filter((grant) =>
		matchesTransferGrantRequest(grant, request),
	);
}

export function matchesTransferGrantRequest(
	grant: PermissionGrant,
	request: TransferActionRequest,
): boolean {
	const constraints = grant.constraints;
	if (!constraints) {
		return true;
	}

	if (typeof constraints.asset === "string" && constraints.asset !== request.asset) {
		return false;
	}

	if (typeof constraints.chain === "string" && constraints.chain !== request.chain) {
		return false;
	}

	if (
		typeof constraints.toAddress === "string" &&
		constraints.toAddress.toLowerCase() !== request.toAddress.toLowerCase()
	) {
		return false;
	}

	if (typeof constraints.maxAmount === "string") {
		try {
			const maxAmount =
				request.asset === "native"
					? parseEther(constraints.maxAmount)
					: parseUnits(constraints.maxAmount, getUsdcAsset(request.chain)?.decimals ?? 6);
			const requestedAmount =
				request.asset === "native"
					? parseEther(request.amount)
					: parseUnits(request.amount, getUsdcAsset(request.chain)?.decimals ?? 6);
			if (requestedAmount > maxAmount) {
				return false;
			}
		} catch {
			return false;
		}
	}

	return true;
}
