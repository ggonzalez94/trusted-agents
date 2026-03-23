import {
	type Erc20Asset,
	ValidationError,
	getUsdcAsset as getCoreUsdcAsset,
} from "trusted-agents-core";

export type { Erc20Asset } from "trusted-agents-core";

export function getUsdcAsset(chain: string): Erc20Asset | undefined {
	return getCoreUsdcAsset(chain);
}

export function normalizeAsset(asset: string): "native" | "usdc" {
	const normalized = asset.trim().toLowerCase();
	if (normalized === "native" || normalized === "usdc") {
		return normalized;
	}
	throw new ValidationError(`Unsupported asset: ${asset}. Use "native" or "usdc".`);
}
