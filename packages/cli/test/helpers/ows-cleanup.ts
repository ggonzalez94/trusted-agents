import { deletePolicy, deleteWallet, listApiKeys, revokeApiKey } from "@open-wallet-standard/core";
import { afterEach, beforeEach } from "vitest";

/**
 * Tracks OWS wallets, policies, and API keys created during tests and cleans them up after each test.
 * Returns tracking arrays and a `trackOwsArtifacts(yaml)` helper to parse and track artifacts from config YAML.
 *
 * Only revokes API keys that were created after the snapshot (taken lazily on first
 * trackOwsArtifacts call), so that real agent keys in the shared vault are never deleted.
 */
export function useOwsArtifactCleanup() {
	const createdWallets: string[] = [];
	const createdPolicies: string[] = [];
	const createdApiKeyIds: string[] = [];
	let preExistingKeyIds: Set<string> | null = null;

	beforeEach(() => {
		try {
			const keys = listApiKeys();
			preExistingKeyIds = new Set(keys.map((k: { id: string }) => k.id));
		} catch (_) {
			// If we can't snapshot the vault, mark as null so trackOwsArtifacts
			// skips key revocation — avoids accidentally revoking real keys.
			preExistingKeyIds = null;
		}
	});

	afterEach(() => {
		for (const keyId of createdApiKeyIds) {
			try {
				revokeApiKey(keyId);
			} catch (_) {
				/* ignore */
			}
		}
		for (const policyId of createdPolicies) {
			try {
				deletePolicy(policyId);
			} catch (_) {
				/* ignore */
			}
		}
		for (const walletName of createdWallets) {
			try {
				deleteWallet(walletName);
			} catch (_) {
				/* ignore */
			}
		}
		createdApiKeyIds.length = 0;
		createdPolicies.length = 0;
		createdWallets.length = 0;
	});

	function trackOwsArtifacts(yaml: Record<string, unknown>) {
		const ows = yaml.ows as { wallet?: string } | undefined;
		if (ows?.wallet) {
			createdWallets.push(ows.wallet);
		}
		if (preExistingKeyIds !== null) {
			try {
				const keys = listApiKeys();
				for (const k of keys) {
					if (!preExistingKeyIds.has(k.id)) {
						createdApiKeyIds.push(k.id);
					}
				}
			} catch (_) {
				/* ignore */
			}
		}
	}

	return { createdWallets, createdPolicies, createdApiKeyIds, trackOwsArtifacts };
}
