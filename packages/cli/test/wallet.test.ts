import type { ChainConfig } from "trusted-agents-core";
import { describe, expect, it } from "vitest";
import { buildPublicClient, buildWalletClient } from "../src/lib/wallet.js";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_CHAIN: ChainConfig = {
	chainId: 84532,
	caip2: "eip155:84532",
	name: "Base Sepolia",
	rpcUrl: "https://sepolia.base.org",
	registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
};

describe("wallet", () => {
	it("should build a wallet client", () => {
		const client = buildWalletClient(TEST_KEY, TEST_CHAIN);
		expect(client).toBeDefined();
		expect(client.account?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
	});

	it("should build a public client", () => {
		const client = buildPublicClient(TEST_CHAIN);
		expect(client).toBeDefined();
	});
});
