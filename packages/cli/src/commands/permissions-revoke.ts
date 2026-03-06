import { nowISO } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { findContactForPeer } from "../lib/message-conversations.js";
import { error, success, verbose } from "../lib/output.js";
import { publishGrantSet } from "../lib/permission-workflows.js";
import type { GlobalOptions } from "../types.js";

export async function permissionsRevokeCommand(
	peer: string,
	grantId: string,
	opts: GlobalOptions,
	cmdOpts?: { note?: string },
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);
		const contacts = await ctx.trustStore.getContacts();
		const contact = findContactForPeer(contacts, peer);
		if (!contact) {
			error("NOT_FOUND", `Peer not found in contacts: ${peer}`, opts);
			process.exitCode = 1;
			return;
		}

		const grantSet = {
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
			process.exitCode = 1;
			return;
		}

		verbose(`Revoking grant ${grantId} for ${contact.peerDisplayName}...`, opts);

		await ctx.transport.start?.();
		try {
			const response = await publishGrantSet({
				config,
				ctx,
				contact,
				grantSet,
				note: cmdOpts?.note ?? `Revoked ${grantId}`,
			});

			success(
				{
					revoked: true,
					peer: contact.peerDisplayName,
					agent_id: contact.peerAgentId,
					grant: match,
					response,
				},
				opts,
				startTime,
			);
		} finally {
			await ctx.transport.stop?.();
		}
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
