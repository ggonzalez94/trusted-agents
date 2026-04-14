import { type Contact, FileTrustStore, TransportOwnershipError } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, info, success } from "../lib/output.js";
import { TapdClient, TapdNotRunningError } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

/**
 * `tap contacts remove <connectionId>` — best-effort revoke + local delete.
 * If tapd is running, route through `POST /api/contacts/:id/revoke` so the
 * daemon owns the live transport and journal. Otherwise fall back to local
 * file mutation (legacy single-process path).
 */
export async function contactsRemoveCommand(
	connectionId: string,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);

		// Try to route through tapd first.
		try {
			const client = await TapdClient.forDataDir(config.dataDir);
			const result = await client.revokeContact(connectionId);
			success({ removed: connectionId, peer: result.peer }, opts, startTime);
			return;
		} catch (err) {
			if (!(err instanceof TapdNotRunningError)) {
				throw err;
			}
			// Fall through to local mutation.
		}

		// Local fallback: read the trust store directly. We deliberately do
		// NOT spin up a TapMessagingService here; revoke delivery only works
		// when tapd is running. This matches the existing behavior where the
		// daemon-owning host (plugin or sidecar) handles revoke delivery.
		const trustStore = new FileTrustStore(config.dataDir);
		const contacts: Contact[] = await trustStore.getContacts();
		const contact = contacts.find((c) => c.connectionId === connectionId);
		if (!contact) {
			error("NOT_FOUND", `Contact not found: ${connectionId}`, opts);
			process.exitCode = 4;
			return;
		}

		await trustStore.removeContact(connectionId);
		info(
			`tapd is not running — removed ${contact.peerDisplayName} locally without sending revoke. Run \`tap daemon start\` and re-add the peer to deliver the revoke.`,
			opts,
		);
		success({ removed: connectionId, peer: contact.peerDisplayName }, opts, startTime);
		return;
	} catch (err) {
		// Surface the special "owner held elsewhere" error pattern from before.
		if (err instanceof TransportOwnershipError) {
			error(
				"TRANSPORT_ERROR",
				"Contact removal must run through the active TAP owner so revoke can be delivered first.",
				opts,
			);
			process.exitCode = 2;
			return;
		}
		handleCommandError(err, opts);
	}
}
