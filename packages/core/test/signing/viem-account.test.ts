import { describe, expect, it } from "vitest";
import type { SigningProvider } from "../../src/signing/provider.js";
import { createSigningProviderViemAccount } from "../../src/signing/viem-account.js";

function createMockProvider(
	address: `0x${string}` = "0xabcdef0123456789abcdef0123456789abcdef01",
): SigningProvider {
	return {
		getAddress: async () => address,
		signMessage: async () => "0xdeadbeef" as `0x${string}`,
		signTypedData: async () => "0xdeadbeef" as `0x${string}`,
		signTransaction: async () => "0xdeadbeef" as `0x${string}`,
		signAuthorization: async () => ({
			contractAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
			chainId: 8453,
			nonce: 0,
			r: "0x0" as `0x${string}`,
			s: "0x0" as `0x${string}`,
			v: 27n,
		}),
	};
}

describe("createSigningProviderViemAccount", () => {
	it("returns account with correct address", async () => {
		const address = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;
		const provider = createMockProvider(address);
		const account = await createSigningProviderViemAccount(provider);
		expect(account.address).toBe(address);
	});

	it("delegates signMessage to provider", async () => {
		const provider = createMockProvider();
		const account = await createSigningProviderViemAccount(provider);
		const sig = await account.signMessage({ message: "hello" });
		expect(sig).toBe("0xdeadbeef");
	});

	it("delegates signTransaction to provider", async () => {
		const provider = createMockProvider();
		const account = await createSigningProviderViemAccount(provider);
		const sig = await account.signTransaction({
			to: "0x0000000000000000000000000000000000000000",
			value: 0n,
		});
		expect(sig).toBe("0xdeadbeef");
	});

	it("delegates signTypedData to provider", async () => {
		const provider = createMockProvider();
		const account = await createSigningProviderViemAccount(provider);
		const sig = await account.signTypedData({
			domain: {},
			types: { EIP712Domain: [] },
			primaryType: "EIP712Domain",
			message: {},
		});
		expect(sig).toBe("0xdeadbeef");
	});
});
