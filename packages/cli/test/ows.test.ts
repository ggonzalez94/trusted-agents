import { createWallet, deleteWallet } from "@open-wallet-standard/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createOwsWallet,
	deriveXmtpDbEncryptionKey,
	getOwsWalletAddress,
	isOwsInstalled,
	listOwsWallets,
} from "../src/lib/ows.js";

const TEST_PREFIX = `ows-test-${Date.now()}`;
const WALLET_NAME = `${TEST_PREFIX}-wallet`;
const PASSPHRASE = "test-passphrase";

describe("OWS helpers", () => {
	beforeAll(() => {
		// Ensure test wallet exists for read-only helpers
		createWallet(WALLET_NAME, PASSPHRASE);
	});

	afterAll(() => {
		// Cleanup: best-effort removal of test artifacts
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

		it("creates a wallet and returns its EVM address", () => {
			const result = createOwsWallet(newWalletName, PASSPHRASE);
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

	describe("deriveXmtpDbEncryptionKey", () => {
		it("returns a 0x-prefixed 32-byte hex string", () => {
			const key = deriveXmtpDbEncryptionKey(WALLET_NAME, "eip155:8453", PASSPHRASE);
			expect(key).toMatch(/^0x[0-9a-fA-F]{64}$/);

			// Deterministic — same inputs produce same key
			const key2 = deriveXmtpDbEncryptionKey(WALLET_NAME, "eip155:8453", PASSPHRASE);
			expect(key).toBe(key2);
		});
	});
});
