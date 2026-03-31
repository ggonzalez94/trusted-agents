import {
	createApiKey,
	createPolicy,
	createWallet,
	deletePolicy,
	deleteWallet,
	revokeApiKey,
} from "@open-wallet-standard/core";
import { recoverAddress } from "viem";
import { hashAuthorization } from "viem/experimental";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OwsSigningProvider } from "../../src/signing/ows-provider.js";

const WALLET_NAME = `tap-test-${Date.now()}`;
const POLICY_ID = `test-policy-${Date.now()}`;
const CHAIN = "eip155:8453";
const PASSPHRASE = "test-passphrase";

let apiKey: string;
let keyId: string;

describe("OwsSigningProvider", () => {
	beforeAll(() => {
		createWallet(WALLET_NAME, PASSPHRASE);

		createPolicy(
			JSON.stringify({
				id: POLICY_ID,
				name: "test-all",
				version: 1,
				created_at: new Date().toISOString(),
				rules: [{ type: "allowed_chains", chain_ids: [CHAIN] }],
				action: "deny",
			}),
		);

		const result = createApiKey(`test-key-${Date.now()}`, [WALLET_NAME], [POLICY_ID], PASSPHRASE);
		apiKey = result.token;
		keyId = result.id;
	});

	afterAll(() => {
		try {
			revokeApiKey(keyId);
		} catch (_) {
			/* ignore cleanup errors */
		}
		try {
			deletePolicy(POLICY_ID);
		} catch (_) {
			/* ignore cleanup errors */
		}
		try {
			deleteWallet(WALLET_NAME);
		} catch (_) {
			/* ignore cleanup errors */
		}
	});

	it("getAddress returns a valid EVM address", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const address = await provider.getAddress();
		expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
	});

	it("getAddress caches the result", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const addr1 = await provider.getAddress();
		const addr2 = await provider.getAddress();
		expect(addr1).toBe(addr2);
	});

	it("signMessage with a string returns a valid hex signature", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const sig = await provider.signMessage("hello world");
		expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
		// 65-byte ECDSA signature = 130 hex chars + 0x prefix
		expect(sig.length).toBe(132);
	});

	it("signMessage is deterministic (RFC 6979)", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const sig1 = await provider.signMessage("deterministic-test");
		const sig2 = await provider.signMessage("deterministic-test");
		expect(sig1).toBe(sig2);
	});

	it("signMessage with raw Uint8Array works", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const raw = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
		const sig = await provider.signMessage({ raw });
		expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
		expect(sig.length).toBe(132);
	});

	it("signMessage with raw hex string works", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const sig = await provider.signMessage({ raw: "0x68656c6c6f" });
		expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
		expect(sig.length).toBe(132);
	});

	it("signTypedData returns a valid signature", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const sig = await provider.signTypedData({
			domain: {
				name: "Test",
				version: "1",
				chainId: 8453,
			},
			types: {
				TestMessage: [{ name: "value", type: "uint256" }],
			},
			primaryType: "TestMessage",
			message: { value: 42 },
		});
		expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
		expect(sig.length).toBe(132);
	});

	it("signTransaction returns a valid signature", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const sig = await provider.signTransaction({
			to: "0x0000000000000000000000000000000000000001",
			value: 0n,
			chainId: 8453,
			maxFeePerGas: 1000000000n,
			maxPriorityFeePerGas: 100000000n,
			gas: 21000n,
			nonce: 0,
			type: "eip1559",
		});
		expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
	});

	it("signAuthorization returns a valid signed authorization", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const auth = await provider.signAuthorization({
			contractAddress: "0x0000000000000000000000000000000000000001",
			chainId: 8453,
			nonce: 0,
		});
		expect(auth.contractAddress).toBe("0x0000000000000000000000000000000000000001");
		expect(auth.chainId).toBe(8453);
		expect(auth.nonce).toBe(0);
		expect(auth.r).toMatch(/^0x[0-9a-fA-F]{64}$/);
		expect(auth.s).toMatch(/^0x[0-9a-fA-F]{64}$/);
		expect(auth.v === 27n || auth.v === 28n).toBe(true);
	});

	it("signAuthorization signature recovers to the correct address", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		const address = await provider.getAddress();

		const authParams = {
			contractAddress: "0x0000000000000000000000000000000000000001" as `0x${string}`,
			chainId: 8453,
			nonce: 0,
		};
		const auth = await provider.signAuthorization(authParams);

		// Compute the EIP-7702 authorization hash the same way viem does
		const authHash = hashAuthorization(authParams);

		// Recover the signer from the signature + hash
		const recovered = await recoverAddress({
			hash: authHash,
			signature: { r: auth.r, s: auth.s, v: auth.v },
		});

		expect(recovered.toLowerCase()).toBe(address.toLowerCase());
	});

	it("signAuthorization throws if chainId is missing", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		await expect(
			provider.signAuthorization({
				contractAddress: "0x0000000000000000000000000000000000000001",
			}),
		).rejects.toThrow("chainId is required");
	});

	it("signAuthorization throws if nonce is missing", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, apiKey);
		await expect(
			provider.signAuthorization({
				contractAddress: "0x0000000000000000000000000000000000000001",
				chainId: 8453,
			}),
		).rejects.toThrow("nonce is required");
	});

	it("getAddress throws for wallet with no EVM account", async () => {
		// This test uses a non-existent wallet to trigger the error path
		const provider = new OwsSigningProvider("nonexistent-wallet-xyz", CHAIN, apiKey);
		await expect(provider.getAddress()).rejects.toThrow();
	});
});
