import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, info, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function contactsRemoveCommand(
	connectionId: string,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const runtime = await createCliRuntime({ config, opts, ownerLabel: "tap:contacts-remove" });

		// Find the contact first
		const contacts = await runtime.trustStore.getContacts();
		const contact = contacts.find((c) => c.connectionId === connectionId);
		if (!contact) {
			error("NOT_FOUND", `Contact not found: ${connectionId}`, opts);
			process.exitCode = 4;
			return;
		}

		// Send connection/revoke to the peer (best-effort — local delete always happens)
		try {
			await runtime.service.revokeConnection(contact);
			info(`Sent connection/revoke to ${contact.peerDisplayName} (#${contact.peerAgentId}).`, opts);
		} catch (err) {
			info(
				`Could not deliver connection/revoke to ${contact.peerDisplayName} — removing locally anyway. ${err instanceof Error ? err.message : String(err)}`,
				opts,
			);
		}

		// Delete the local contact regardless of revoke delivery
		await runtime.trustStore.removeContact(connectionId);

		success({ removed: connectionId, peer: contact.peerDisplayName }, opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
