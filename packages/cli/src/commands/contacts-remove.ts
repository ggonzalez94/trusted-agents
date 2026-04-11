import { TransportOwnershipError } from "trusted-agents-core";
import type { TapRuntime } from "trusted-agents-sdk";
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
	let runtime: TapRuntime | undefined;

	try {
		const config = await loadConfig(opts);
		runtime = await createCliRuntime({ config, opts, ownerLabel: "tap:contacts-remove" });

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
			if (err instanceof TransportOwnershipError) {
				error(
					"TRANSPORT_ERROR",
					`Contact removal must run through the active TAP owner so revoke can be delivered first. Use the running TAP host to remove ${contact.peerDisplayName}.`,
					opts,
				);
				process.exitCode = 2;
				return;
			}
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
	} finally {
		// Release the transport owner lock and any XMTP resources held by the
		// runtime. Important for short-lived CLI commands so parallel tap
		// processes can acquire the lock without waiting for process exit.
		if (runtime) {
			await runtime.stop().catch(() => {
				/* best-effort: cleanup failures should not mask the primary outcome */
			});
		}
	}
}
