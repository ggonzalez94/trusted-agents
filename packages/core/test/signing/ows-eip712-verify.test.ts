import {
	createApiKey,
	createPolicy,
	createWallet,
	deletePolicy,
	deleteWallet,
	revokeApiKey,
} from "@open-wallet-standard/core";
import { verifyTypedData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OwsSigningProvider } from "../../src/signing/ows-provider.js";
import { createSigningProviderViemAccount } from "../../src/signing/viem-account.js";

const WALLET_NAME = `tap-eip712-test-${Date.now()}`;
const POLICY_ID = `eip712-policy-${Date.now()}`;
const CHAIN_BASE = "eip155:8453";
const CHAIN_TAIKO = "eip155:167000";
const PASSPHRASE = "test-passphrase-eip712";

let apiKey: string;
let keyId: string;
let signerAddress: `0x${string}`;

// EIP-3009 TransferWithAuthorization — the struct x402 uses
const transferWithAuthTypes = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;

// Base mainnet USDC domain
const baseUsdcDomain = {
	name: "USD Coin",
	version: "2",
	chainId: 8453,
	verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
} as const;

// Taiko USDC domain
const taikoUsdcDomain = {
	name: "USD Coin",
	version: "2",
	chainId: 167000,
	verifyingContract: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b" as `0x${string}`,
} as const;

describe("OWS EIP-712 signature verification", () => {
	beforeAll(() => {
		createWallet(WALLET_NAME, PASSPHRASE);

		createPolicy(
			JSON.stringify({
				id: POLICY_ID,
				name: "eip712-test-policy",
				version: 1,
				created_at: new Date().toISOString(),
				rules: [{ type: "allowed_chains", chain_ids: [CHAIN_BASE, CHAIN_TAIKO] }],
				action: "deny",
			}),
		);

		const result = createApiKey(`eip712-key-${Date.now()}`, [WALLET_NAME], [POLICY_ID], PASSPHRASE);
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

	it("TransferWithAuthorization on Base — signature verifies", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN_BASE, apiKey);
		signerAddress = await provider.getAddress();

		const message = {
			from: signerAddress,
			to: "0x0000000000000000000000000000000000000001" as `0x${string}`,
			value: 1000000n,
			validAfter: 0n,
			validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
			nonce: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
		};

		const sig = await provider.signTypedData({
			domain: baseUsdcDomain,
			types: transferWithAuthTypes,
			primaryType: "TransferWithAuthorization",
			message,
		});

		expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);

		const valid = await verifyTypedData({
			address: signerAddress,
			domain: baseUsdcDomain,
			types: transferWithAuthTypes,
			primaryType: "TransferWithAuthorization",
			message,
			signature: sig,
		});
		expect(valid).toBe(true);
	});

	it("TransferWithAuthorization on Taiko — signature verifies", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN_TAIKO, apiKey);
		const address = await provider.getAddress();

		const message = {
			from: address,
			to: "0x0000000000000000000000000000000000000002" as `0x${string}`,
			value: 500000n,
			validAfter: 0n,
			validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
			nonce: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
		};

		const sig = await provider.signTypedData({
			domain: taikoUsdcDomain,
			types: transferWithAuthTypes,
			primaryType: "TransferWithAuthorization",
			message,
		});

		expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);

		const valid = await verifyTypedData({
			address,
			domain: taikoUsdcDomain,
			types: transferWithAuthTypes,
			primaryType: "TransferWithAuthorization",
			message,
			signature: sig,
		});
		expect(valid).toBe(true);
	});

	it("viem account adapter — signTypedData verifies (x402 path)", async () => {
		const provider = new OwsSigningProvider(WALLET_NAME, CHAIN_BASE, apiKey);
		const account = await createSigningProviderViemAccount(provider);

		const message = {
			from: account.address,
			to: "0x0000000000000000000000000000000000000003" as `0x${string}`,
			value: 250000n,
			validAfter: 0n,
			validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
			nonce: "0x0000000000000000000000000000000000000000000000000000000000000003" as `0x${string}`,
		};

		const sig = await account.signTypedData({
			domain: baseUsdcDomain,
			types: transferWithAuthTypes,
			primaryType: "TransferWithAuthorization",
			message,
		});

		expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);

		const valid = await verifyTypedData({
			address: account.address,
			domain: baseUsdcDomain,
			types: transferWithAuthTypes,
			primaryType: "TransferWithAuthorization",
			message,
			signature: sig,
		});
		expect(valid).toBe(true);
	});
});
