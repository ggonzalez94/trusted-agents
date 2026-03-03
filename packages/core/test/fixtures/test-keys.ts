import { privateKeyToAccount } from "viem/accounts";

// Well-known Hardhat/Anvil test private keys (never use in production)
export const ALICE_PRIVATE_KEY =
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const BOB_PRIVATE_KEY =
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

export const ALICE = {
	privateKey: ALICE_PRIVATE_KEY,
	account: privateKeyToAccount(ALICE_PRIVATE_KEY),
	get address() {
		return this.account.address;
	},
};

export const BOB = {
	privateKey: BOB_PRIVATE_KEY,
	account: privateKeyToAccount(BOB_PRIVATE_KEY),
	get address() {
		return this.account.address;
	},
};
