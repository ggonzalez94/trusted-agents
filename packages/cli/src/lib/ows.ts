import {
	createWallet,
	getWallet,
	importWalletPrivateKey,
	listWallets,
	signMessage,
} from "@open-wallet-standard/core";
import type { WalletInfo } from "@open-wallet-standard/core";
import { keccak256, toHex } from "viem";

export interface OwsWalletEntry {
	id: string;
	name: string;
	address: string;
}

/**
 * Check whether the OWS Node.js SDK is functional.
 * The SDK is a native NAPI module — if it loads and `listWallets()` succeeds,
 * OWS is available.
 */
export function isOwsInstalled(): boolean {
	try {
		listWallets();
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure OWS is installed and working. Throws with install instructions if not.
 */
export async function ensureOwsInstalled(): Promise<void> {
	if (isOwsInstalled()) return;

	// Check if the CLI binary is present but the SDK is missing
	const { execSync } = await import("node:child_process");
	try {
		execSync("ows --version", { stdio: "pipe" });
		throw new Error(
			"OWS CLI is installed but the Node.js SDK is not available. Run: bun add @open-wallet-standard/core",
		);
	} catch (e) {
		// If we already threw a descriptive error above, re-throw it
		if (e instanceof Error && e.message.includes("Node.js SDK")) {
			throw e;
		}
		throw new Error(
			"Open Wallet Standard is required. Install with: curl -fsSL https://docs.openwallet.sh/install.sh | bash",
		);
	}
}

/**
 * Extract the EVM address from an OWS wallet.
 * Returns the address from the first eip155: account.
 */
function evmAddressFromWallet(wallet: WalletInfo): string | undefined {
	const evmAccount = wallet.accounts.find((a) => a.chainId.startsWith("eip155:"));
	return evmAccount?.address;
}

/**
 * List all OWS wallets with their EVM addresses.
 * Wallets without an EVM account are excluded.
 */
export function listOwsWallets(): OwsWalletEntry[] {
	const wallets = listWallets();
	const result: OwsWalletEntry[] = [];
	for (const w of wallets) {
		const address = evmAddressFromWallet(w);
		if (address) {
			result.push({ id: w.id, name: w.name, address });
		}
	}
	return result;
}

/**
 * Create a new OWS wallet with the given name and optional passphrase.
 * Returns the wallet name and EVM address.
 */
export function createOwsWallet(
	name: string,
	passphrase?: string,
): { name: string; address: string } {
	const wallet = createWallet(name, passphrase ?? undefined);
	const address = evmAddressFromWallet(wallet);
	if (!address) {
		throw new Error(`Wallet "${name}" was created but has no EVM account.`);
	}
	return { name: wallet.name, address };
}

/**
 * Get the EVM address for an existing OWS wallet.
 */
export function getOwsWalletAddress(nameOrId: string): string {
	const wallet = getWallet(nameOrId);
	const address = evmAddressFromWallet(wallet);
	if (!address) {
		throw new Error(`Wallet "${nameOrId}" has no EVM account.`);
	}
	return address;
}

/**
 * Derive a deterministic XMTP DB encryption key by signing a fixed message
 * with the OWS wallet and hashing the signature.
 *
 * This produces a stable 32-byte key that survives restarts without storing
 * additional secrets — only the wallet + passphrase are needed.
 */
export function deriveXmtpDbEncryptionKey(
	walletName: string,
	chain: string,
	passphrase: string,
): `0x${string}` {
	const result = signMessage(walletName, chain, "xmtp-db-encryption-key", passphrase);
	return keccak256(toHex(result.signature));
}

/**
 * Import an existing hex-encoded private key into OWS.
 * Returns the wallet name and EVM address.
 */
export function importOwsWalletPrivateKey(
	name: string,
	privateKeyHex: string,
	passphrase?: string,
): { name: string; address: string } {
	const wallet = importWalletPrivateKey(name, privateKeyHex, passphrase ?? undefined);
	const address = evmAddressFromWallet(wallet);
	if (!address) {
		throw new Error(`Wallet "${name}" was imported but has no EVM account.`);
	}
	return { name: wallet.name, address };
}
