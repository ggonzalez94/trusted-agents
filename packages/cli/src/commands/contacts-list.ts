import { FileTrustStore } from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { error, success } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";

export async function contactsListCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const store = new FileTrustStore(config.dataDir);
		const contacts = await store.getContacts();

		const formatted = contacts.map((c) => ({
			name: c.peerDisplayName,
			agent_id: c.peerAgentId,
			chain: c.peerChain,
			status: c.status,
			connection_id: c.connectionId,
			last_contact: c.lastContactAt,
		}));

		success({ contacts: formatted }, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
