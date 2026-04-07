import { createWallet, deletePolicy, deleteWallet, revokeApiKey } from "@open-wallet-standard/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createOwsApiKey,
	createOwsPolicy,
	createOwsWallet,
	deriveXmtpDbEncryptionKey,
	findCompatiblePolicies,
	getOwsWalletAddress,
	isOwsInstalled,
	listOwsWallets,
} from "../src/lib/ows.js";

const TEST_PREFIX = `ows-test-${Date.now()}`;
const WALLET_NAME = `${TEST_PREFIX}-wallet`;
const POLICY_ID = `${TEST_PREFIX}-policy`;
const PASSPHRASE = "test-passphrase";

let apiKeyId: string | undefined;
let walletId: string;

describe("OWS helpers", () => {
	beforeAll(() => {
		// Ensure test wallet exists for read-only helpers
		const w = createWallet(WALLET_NAME, PASSPHRASE);
		walletId = w.id;
	});

	afterAll(() => {
		// Cleanup: best-effort removal of test artifacts
		if (apiKeyId) {
			try {
				revokeApiKey(apiKeyId);
			} catch (_) {
				/* ignore */
			}
		}
		try {
			deletePolicy(POLICY_ID);
		} catch (_) {
			/* ignore */
		}
		try {
			deleteWallet(WALLET_NAME);
		} catch (_) {
			/* ignore */
		}
	});

	describe("isOwsInstalled", () => {
		it("returns true when OWS SDK is working", () => {
			expect(isOwsInstalled()).toBe(true);
		});
	});

	describe("listOwsWallets", () => {
		it("returns an array including the test wallet", () => {
			const wallets = listOwsWallets();
			expect(Array.isArray(wallets)).toBe(true);
			const found = wallets.find((w) => w.name === WALLET_NAME);
			expect(found).toBeDefined();
			expect(found!.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
		});
	});

	describe("createOwsWallet", () => {
		const newWalletName = `${TEST_PREFIX}-create`;

		afterAll(() => {
			try {
				deleteWallet(newWalletName);
			} catch (_) {
				/* ignore */
			}
		});

		it("creates a wallet and returns its ID and EVM address", () => {
			const result = createOwsWallet(newWalletName, PASSPHRASE);
			expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(result.name).toBe(newWalletName);
			expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
		});
	});

	describe("getOwsWalletAddress", () => {
		it("returns the EVM address for an existing wallet", () => {
			const address = getOwsWalletAddress(WALLET_NAME);
			expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
		});

		it("throws for a non-existent wallet", () => {
			expect(() => getOwsWalletAddress("nonexistent-wallet-xyz")).toThrow();
		});
	});

	describe("createOwsPolicy", () => {
		it("creates a policy and returns the policy ID", () => {
			const oneYear = new Date();
			oneYear.setFullYear(oneYear.getFullYear() + 1);

			const id = createOwsPolicy({
				id: POLICY_ID,
				chains: ["eip155:8453"],
				expiresAt: oneYear.toISOString(),
			});
			expect(id).toBe(POLICY_ID);
		});
	});

	describe("findCompatiblePolicies", () => {
		it("finds the test policy for eip155:8453", () => {
			const policies = findCompatiblePolicies("eip155:8453");
			const found = policies.find((p) => p.id === POLICY_ID);
			expect(found).toBeDefined();
			expect(found!.chains).toContain("eip155:8453");
		});

		it("returns empty for an unknown chain", () => {
			const policies = findCompatiblePolicies("eip155:999999");
			const found = policies.find((p) => p.id === POLICY_ID);
			expect(found).toBeUndefined();
		});
	});

	describe("createOwsApiKey", () => {
		it("creates an API key and returns a token starting with ows_key_", () => {
			const result = createOwsApiKey({
				name: `${TEST_PREFIX}-key`,
				walletId,
				policyId: POLICY_ID,
				passphrase: PASSPHRASE,
			});
			expect(result.token).toMatch(/^ows_key_/);
			expect(result.id).toBeTruthy();
			apiKeyId = result.id;
		});
	});

	describe("deriveXmtpDbEncryptionKey", () => {
		it("returns a 0x-prefixed 32-byte hex string", () => {
			// Need an API key to sign
			const keyResult = createOwsApiKey({
				name: `${TEST_PREFIX}-derive-key`,
				walletId,
				policyId: POLICY_ID,
				passphrase: PASSPHRASE,
			});

			const key = deriveXmtpDbEncryptionKey(WALLET_NAME, "eip155:8453", keyResult.token);
			expect(key).toMatch(/^0x[0-9a-fA-F]{64}$/);

			// Deterministic — same inputs produce same key
			const key2 = deriveXmtpDbEncryptionKey(WALLET_NAME, "eip155:8453", keyResult.token);
			expect(key).toBe(key2);

			// Cleanup
			try {
				revokeApiKey(keyResult.id);
			} catch (_) {
				/* ignore */
			}
		});
	});
});
