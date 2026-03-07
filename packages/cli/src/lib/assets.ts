import { type Erc20Asset, getUsdcAsset as getCoreUsdcAsset } from "trusted-agents-core";

export type { Erc20Asset } from "trusted-agents-core";

export function getUsdcAsset(chain: string): Erc20Asset | undefined {
	return getCoreUsdcAsset(chain);
}
