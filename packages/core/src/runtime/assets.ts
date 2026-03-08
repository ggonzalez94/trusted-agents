export interface Erc20Asset {
	symbol: string;
	address: `0x${string}`;
	decimals: number;
}

const USDC_BY_CHAIN: Record<string, Erc20Asset> = {
	"eip155:8453": {
		symbol: "USDC",
		address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		decimals: 6,
	},
	"eip155:84532": {
		symbol: "USDC",
		address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		decimals: 6,
	},
	"eip155:167000": {
		symbol: "USDC",
		address: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
		decimals: 6,
	},
	"eip155:167013": {
		symbol: "USDC",
		address: "0xf501925c8FE6c5B2FC8faD86b8C9acb2596f3295",
		decimals: 6,
	},
};

export function getUsdcAsset(chain: string): Erc20Asset | undefined {
	return USDC_BY_CHAIN[chain];
}
