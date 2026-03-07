import { FileTrustStore, getPermissionLedgerPath } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { findContactForPeer } from "../lib/message-conversations.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function permissionsShowCommand(
	peer: string | undefined,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const store = new FileTrustStore(config.dataDir);
		const contacts = await store.getContacts();

		if (!peer) {
			success(
				{
					contacts: contacts.map((contact) => ({
						name: contact.peerDisplayName,
						agent_id: contact.peerAgentId,
						connection_id: contact.connectionId,
						granted_by_me: contact.permissions.grantedByMe.grants.length,
						granted_by_peer: contact.permissions.grantedByPeer.grants.length,
					})),
					ledger_path: getPermissionLedgerPath(config.dataDir),
				},
				opts,
				startTime,
			);
			return;
		}

		const contact = findContactForPeer(contacts, peer);
		if (!contact) {
			error("NOT_FOUND", `Peer not found in contacts: ${peer}`, opts);
			process.exitCode = 1;
			return;
		}

		success(
			{
				connection_id: contact.connectionId,
				name: contact.peerDisplayName,
				agent_id: contact.peerAgentId,
				chain: contact.peerChain,
				status: contact.status,
				granted_by_me: contact.permissions.grantedByMe,
				granted_by_peer: contact.permissions.grantedByPeer,
				ledger_path: getPermissionLedgerPath(config.dataDir),
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
