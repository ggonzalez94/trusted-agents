import { FileTrustStore } from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { error, success } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";

export async function contactsRemoveCommand(
	connectionId: string,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const store = new FileTrustStore(config.dataDir);

		// Check if contact exists before removing
		const contacts = await store.getContacts();
		const exists = contacts.some((c) => c.connectionId === connectionId);
		if (!exists) {
			error("NOT_FOUND", `Contact not found: ${connectionId}`, opts);
			process.exitCode = 1;
			return;
		}

		await store.removeContact(connectionId);

		success({ removed: connectionId }, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
