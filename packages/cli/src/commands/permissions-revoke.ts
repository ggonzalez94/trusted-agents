import {
	type Contact,
	FileTrustStore,
	type PermissionGrantSet,
	nowISO,
	requireActiveContact,
} from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

export async function permissionsRevokeCommand(
	peer: string,
	grantId: string,
	opts: GlobalOptions,
	cmdOpts?: { note?: string; dryRun?: boolean },
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const contact = await loadActiveContact(config.dataDir, peer);

		const grantSet: PermissionGrantSet = {
			...contact.permissions.grantedByMe,
			updatedAt: nowISO(),
			grants: contact.permissions.grantedByMe.grants.map((grant) =>
				grant.grantId === grantId
					? { ...grant, status: "revoked" as const, updatedAt: nowISO() }
					: grant,
			),
		};

		const match = grantSet.grants.find((grant) => grant.grantId === grantId);
		if (!match) {
			error("NOT_FOUND", `Grant not found for ${contact.peerDisplayName}: ${grantId}`, opts);
			process.exitCode = 4;
			return;
		}

		if (cmdOpts?.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					scope: "permissions/update",
					peer: contact.peerDisplayName,
					agent_id: contact.peerAgentId,
					connection_id: contact.connectionId,
					grant: match,
					note: cmdOpts.note ?? `Revoked ${grantId}`,
				},
				opts,
				startTime,
			);
			return;
		}

		verbose(`Revoking grant ${grantId} for ${contact.peerDisplayName}...`, opts);
		const note = cmdOpts?.note ?? `Revoked ${grantId}`;

		const client = await TapdClient.forDataDir(config.dataDir);
		const result = await client.publishGrants({
			peer,
			grantSet,
			note,
		});

		success(
			{
				revoked: true,
				peer: result.peerName,
				agent_id: result.peerAgentId,
				grant: match,
				response: result.receipt,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

/**
 * Read the active contact directly from the local trust store. We don't go
 * through tapd because the contact list is local data — doing the read
 * locally avoids two HTTP round-trips and works even when tapd just started.
 */
async function loadActiveContact(dataDir: string, peer: string): Promise<Contact> {
	const trustStore = new FileTrustStore(dataDir);
	const contacts = await trustStore.getContacts();
	return requireActiveContact(contacts, peer);
}
