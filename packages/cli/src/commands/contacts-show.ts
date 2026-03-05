import { FileTrustStore } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function contactsShowCommand(nameOrId: string, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const store = new FileTrustStore(config.dataDir);
		const contacts = await store.getContacts();

		// Match by name, connectionId, or agentId
		const agentIdNum = Number.parseInt(nameOrId, 10);
		const contact = contacts.find(
			(c) =>
				c.peerDisplayName.toLowerCase() === nameOrId.toLowerCase() ||
				c.connectionId === nameOrId ||
				(!Number.isNaN(agentIdNum) && c.peerAgentId === agentIdNum),
		);

		if (!contact) {
			error("NOT_FOUND", `Contact not found: ${nameOrId}`, opts);
			process.exitCode = 1;
			return;
		}

		success(
			{
				connection_id: contact.connectionId,
				name: contact.peerDisplayName,
				agent_id: contact.peerAgentId,
				chain: contact.peerChain,
				owner_address: contact.peerOwnerAddress,
				agent_address: contact.peerAgentAddress,
				status: contact.status,
				permissions: Object.entries(contact.permissions)
					.filter(([, v]) => v)
					.map(([k]) => k),
				established_at: contact.establishedAt,
				last_contact: contact.lastContactAt,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
