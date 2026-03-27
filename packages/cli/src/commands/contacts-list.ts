import { FileTrustStore } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function contactsListCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const store = new FileTrustStore(config.dataDir);
		const contacts = await store.getContacts();

		const formatted = contacts.map((c) => ({
			name: c.peerDisplayName,
			agent_id: c.peerAgentId,
			chain: c.peerChain,
			status: c.status,
			connection_id: c.connectionId,
			granted_by_me: c.permissions.grantedByMe.grants.length,
			granted_by_peer: c.permissions.grantedByPeer.grants.length,
			last_contact: c.lastContactAt,
		}));

		success({ contacts: formatted }, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
