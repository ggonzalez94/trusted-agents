import {
	createWallet,
	deleteWallet,
	signTypedData as owsSignTypedData,
} from "@open-wallet-standard/core";
import { hashTypedData, recoverAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OwsSigningProvider } from "../../src/signing/ows-provider.js";

const WALLET_NAME = `tap-test-${Date.now()}`;
const CHAIN = "eip155:8453";
const PASSPHRASE = "test-passphrase";

describe("OwsSigningProvider", () => {
	beforeAll(() => {
		createWallet(WALLET_NAME, PASSPHRASE);
	});

	afterAll(() => {
		try {
			deleteWallet(WALLET_NAME);
		} catch (_) {
			/* ignore cleanup errors */
		}
	});

	it("getAddress returns a valid EVM address", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const address = await provider.getAddress();
		expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
	});

	it("getAddress caches the result", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const addr1 = await provider.getAddress();
		const addr2 = await provider.getAddress();
		expect(addr1).toBe(addr2);
	});

	it("signMessage with a string returns a valid hex signature", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const sig = await provider.signMessage("hello world");
		expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
		// 65-byte ECDSA signature = 130 hex chars + 0x prefix
		expect(sig.length).toBe(132);
	});

	it("signMessage is deterministic (RFC 6979)", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const sig1 = await provider.signMessage("deterministic-test");
		const sig2 = await provider.signMessage("deterministic-test");
		expect(sig1).toBe(sig2);
	});

	it("signMessage with raw Uint8Array works", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const raw = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
		const sig = await provider.signMessage({ raw });
		expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
		expect(sig.length).toBe(132);
	});

	it("signMessage with raw hex string works", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const sig = await provider.signMessage({ raw: "0x68656c6c6f" });
		expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
		expect(sig.length).toBe(132);
	});

	it("signTypedData returns a valid signature", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const typedData = {
			domain: {
				name: "Test",
				version: "1",
				chainId: 8453,
				verifyingContract: "0x0000000000000000000000000000000000000001",
			},
			types: {
				EIP712Domain: [
					{ name: "name", type: "string" },
					{ name: "version", type: "string" },
					{ name: "chainId", type: "uint256" },
					{ name: "verifyingContract", type: "address" },
				],
				Test: [{ name: "value", type: "uint256" }],
			},
			primaryType: "Test",
			message: {
				value: 1,
			},
		};
		const sig = await provider.signTypedData(typedData);
		expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
		expect(sig.length).toBe(132);
		const recovered = await recoverAddress({
			hash: hashTypedData(typedData),
			signature: sig,
		});
		expect(recovered.toLowerCase()).toBe((await provider.getAddress()).toLowerCase());
	});

	it("signTypedData delegates to OWS native typed-data signing", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const typedData = {
			domain: {
				name: "Test",
				version: "1",
				chainId: 8453,
				verifyingContract: "0x0000000000000000000000000000000000000001",
			},
			types: {
				EIP712Domain: [
					{ name: "name", type: "string" },
					{ name: "version", type: "string" },
					{ name: "chainId", type: "uint256" },
					{ name: "verifyingContract", type: "address" },
				],
				Test: [{ name: "value", type: "uint256" }],
			},
			primaryType: "Test",
			message: {
				value: 1,
			},
		};

		const direct = owsSignTypedData(
			WALLET_NAME,
			CHAIN,
			JSON.stringify(typedData),
			PASSPHRASE,
		).signature;
		const providerSig = await provider.signTypedData(typedData);

		expect(providerSig.toLowerCase()).toBe(`0x${direct}`.toLowerCase());
	});

	it("signTypedData serializes bigint fields for x402-style payloads", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const typedData = {
			domain: {
				name: "USD Coin",
				version: "2",
				chainId: 8453,
				verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			},
			types: {
				EIP712Domain: [
					{ name: "name", type: "string" },
					{ name: "version", type: "string" },
					{ name: "chainId", type: "uint256" },
					{ name: "verifyingContract", type: "address" },
				],
				TransferWithAuthorization: [
					{ name: "from", type: "address" },
					{ name: "to", type: "address" },
					{ name: "value", type: "uint256" },
					{ name: "validAfter", type: "uint256" },
					{ name: "validBefore", type: "uint256" },
					{ name: "nonce", type: "bytes32" },
				],
			},
			primaryType: "TransferWithAuthorization",
			message: {
				from: "0x0000000000000000000000000000000000000001",
				to: "0x0000000000000000000000000000000000000002",
				value: 1n,
				validAfter: 0n,
				validBefore: 9999999999n,
				nonce: `0x${"11".repeat(32)}`,
			},
		};

		const sig = await provider.signTypedData(typedData);
		const recovered = await recoverAddress({
			hash: hashTypedData(typedData),
			signature: sig,
		});
		expect(recovered.toLowerCase()).toBe((await provider.getAddress()).toLowerCase());
	});

	it("signTypedData injects EIP712Domain when callers omit it", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		const typedData = {
			domain: {
				name: "USD Coin",
				version: "2",
				chainId: 8453,
				verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			},
			types: {
				TransferWithAuthorization: [
					{ name: "from", type: "address" },
					{ name: "to", type: "address" },
					{ name: "value", type: "uint256" },
					{ name: "validAfter", type: "uint256" },
					{ name: "validBefore", type: "uint256" },
					{ name: "nonce", type: "bytes32" },
				],
			},
			primaryType: "TransferWithAuthorization",
			message: {
				from: await provider.getAddress(),
				to: "0x0000000000000000000000000000000000000002",
				value: 1n,
				validAfter: 0n,
				validBefore: 9999999999n,
				nonce: `0x${"22".repeat(32)}`,
			},
		};

		const sig = await provider.signTypedData(typedData);
		const recovered = await recoverAddress({
			hash: hashTypedData({
				...typedData,
				types: {
					EIP712Domain: [
						{ name: "name", type: "string" },
						{ name: "version", type: "string" },
						{ name: "chainId", type: "uint256" },
						{ name: "verifyingContract", type: "address" },
					],
					...typedData.types,
				},
			}),
			signature: sig,
		});
		expect(recovered.toLowerCase()).toBe((await provider.getAddress()).toLowerCase());
	});

	it("signTransaction returns a valid signature", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
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

	it("reports authorization signatures as unsupported", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		expect(provider.supportsAuthorizationSignatures()).toBe(false);
		await expect(
			provider.signAuthorization({
				contractAddress: "0x0000000000000000000000000000000000000001",
				chainId: 8453,
				nonce: 0,
			}),
		).rejects.toThrow("does not support raw EIP-7702 authorization signing");
	});

	it("signAuthorization throws if chainId is missing", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		await expect(
			provider.signAuthorization({
				contractAddress: "0x0000000000000000000000000000000000000001",
			}),
		).rejects.toThrow("chainId is required");
	});

	it("signAuthorization throws if nonce is missing", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN, PASSPHRASE);
		await expect(
			provider.signAuthorization({
				contractAddress: "0x0000000000000000000000000000000000000001",
				chainId: 8453,
			}),
		).rejects.toThrow("nonce is required");
	});

	it("getAddress throws for wallet with no EVM account", async () => {
		// This test uses a non-existent wallet to trigger the error path
		const provider = new OwsSigningProvider("nonexistent-wallet-xyz", CHAIN, PASSPHRASE);
		await expect(provider.getAddress()).rejects.toThrow();
	});
});
