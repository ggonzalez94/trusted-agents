/**
 * Reset XMTP installations for E2E wallets if saturated.
 *
 * Uses static SDK functions — no Client.create() needed (which would itself
 * fail at the 10-installation limit). Flow:
 *   1. getInboxIdForIdentifier() → get inbox ID from wallet address
 *   2. Client.fetchInboxStates() → count installations
 *   3. Client.revokeInstallations() → revoke all if saturated
 *
 * Safe to run as a CI pre-step: if the inbox is healthy, it's a no-op.
 */
import { Client, type Signer, getInboxIdForIdentifier } from "@xmtp/node-sdk";
import { OwsSigningProvider } from "trusted-agents-core";

const REVOKE_THRESHOLD = 8;

async function createSigner(provider: OwsSigningProvider): Promise<Signer> {
	const address = await provider.getAddress();
	return {
		type: "EOA",
		getIdentifier: () => ({
			identifierKind: 0 as const,
			identifier: address.toLowerCase(),
		}),
		signMessage: async (message: string) => {
			const signature = await provider.signMessage(message);
			return new Uint8Array(Buffer.from(signature.slice(2), "hex"));
		},
	};
}

const walletNames = [process.env.E2E_AGENT_A_OWS_WALLET, process.env.E2E_AGENT_B_OWS_WALLET].filter(
	Boolean,
) as string[];

if (walletNames.length === 0) {
	console.log("No E2E wallet env vars set, skipping XMTP reset.");
	process.exit(0);
}

for (const walletName of walletNames) {
	try {
		const provider = new OwsSigningProvider(walletName, "eip155:8453", "");
		const address = await provider.getAddress();
		const signer = await createSigner(provider);

		// Get inbox ID without creating a client
		const inboxId = await getInboxIdForIdentifier(
			{ identifierKind: 0, identifier: address.toLowerCase() },
			"production",
		);

		if (!inboxId) {
			console.log(`${walletName}: no XMTP inbox found for ${address}, skipping.`);
			continue;
		}

		// Fetch installation count
		const states = await Client.fetchInboxStates([inboxId], "production");
		const installationCount = states[0]?.installations.length ?? 0;

		console.log(
			`${walletName}: inbox ${inboxId.substring(0, 16)}... has ${installationCount} installations`,
		);

		if (installationCount >= REVOKE_THRESHOLD) {
			const installationBytes = states[0]!.installations.map((i) => i.bytes);
			console.log(`  Revoking all ${installationCount} installations...`);
			await Client.revokeInstallations(signer, inboxId, installationBytes, "production");
			console.log("  Done.");
		} else {
			console.log("  Below threshold, no action needed.");
		}
	} catch (err) {
		console.error(`  Failed to reset ${walletName}: ${(err as Error).message}`);
	}
}
