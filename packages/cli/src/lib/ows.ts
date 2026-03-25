import {
	createApiKey,
	createPolicy,
	createWallet,
	getWallet,
	listPolicies,
	listWallets,
	signMessage,
} from "@open-wallet-standard/core";
import type { ApiKeyResult, WalletInfo } from "@open-wallet-standard/core";
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

export interface CreatePolicyOptions {
	id: string;
	chains: string[];
	expiresAt: string;
}

/**
 * Create an OWS policy with the given allowed chains and expiry.
 * Returns the policy ID.
 */
export function createOwsPolicy(opts: CreatePolicyOptions): string {
	const policyJson = JSON.stringify({
		id: opts.id,
		name: `tap-${opts.id}`,
		version: 1,
		created_at: new Date().toISOString(),
		expires_at: opts.expiresAt,
		rules: [{ type: "allowed_chains", chain_ids: opts.chains }],
		action: "deny",
	});
	createPolicy(policyJson);
	return opts.id;
}

export interface CompatiblePolicy {
	id: string;
	name: string;
	chains: string[];
	expiresAt?: string;
}

/**
 * Find policies that include the given chain in their allowed_chains rules.
 */
export function findCompatiblePolicies(chain: string): CompatiblePolicy[] {
	const policies = listPolicies();
	const compatible: CompatiblePolicy[] = [];
	for (const p of policies) {
		const rules = p?.rules;
		if (!Array.isArray(rules)) continue;
		for (const rule of rules) {
			if (
				rule?.type === "allowed_chains" &&
				Array.isArray(rule.chain_ids) &&
				rule.chain_ids.includes(chain)
			) {
				compatible.push({
					id: p.id ?? String(p.name),
					name: p.name ?? p.id ?? "unknown",
					chains: rule.chain_ids as string[],
					expiresAt: p.expires_at,
				});
				break;
			}
		}
	}
	return compatible;
}

export interface CreateApiKeyOptions {
	name: string;
	walletName: string;
	policyId: string;
	passphrase: string;
}

/**
 * Create an OWS API key for the given wallet and policy.
 * Returns the raw token (ows_key_...) and key metadata.
 */
export function createOwsApiKey(opts: CreateApiKeyOptions): ApiKeyResult {
	return createApiKey(opts.name, [opts.walletName], [opts.policyId], opts.passphrase);
}

/**
 * Derive a deterministic XMTP DB encryption key by signing a fixed message
 * with the OWS wallet and hashing the signature.
 *
 * This produces a stable 32-byte key that survives restarts without storing
 * additional secrets — only the wallet + API key are needed.
 */
export function deriveXmtpDbEncryptionKey(
	walletName: string,
	chain: string,
	apiKey: string,
): `0x${string}` {
	const result = signMessage(walletName, chain, "xmtp-db-encryption-key", apiKey);
	return keccak256(toHex(result.signature));
}
