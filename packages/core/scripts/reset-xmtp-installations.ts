/**
 * Reset XMTP installations for E2E wallets if saturated.
 *
 * Uses the static Client.revokeInstallations() API — no client registration needed.
 * Only revokes if an inbox is at or near the 10-installation limit.
 * Safe to run as a CI pre-step: if the inbox is healthy, it's a no-op.
 *
 * Requires: E2E_AGENT_A_OWS_WALLET and E2E_AGENT_B_OWS_WALLET env vars,
 * with the wallets already imported into the OWS vault.
 */
import { Client, type Signer } from "@xmtp/node-sdk";
import { OwsSigningProvider } from "trusted-agents-core";

const REVOKE_THRESHOLD = 8; // Revoke when at or above this count

async function createSigner(provider: OwsSigningProvider): Promise<Signer> {
	const address = await provider.getAddress();
	return {
		type: "EOA",
		getIdentifier: () => ({
			identifierKind: 0 as const, // IdentifierKind.Ethereum
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
		const signer = await createSigner(provider);

		// Create a temporary unregistered client to get the inbox ID
		const tempClient = await Client.create(signer, {
			env: "production",
			disableAutoRegister: true,
			dbPath: null, // in-memory only
		});
		const inboxId = tempClient.inboxId;

		// Fetch current installation count
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
