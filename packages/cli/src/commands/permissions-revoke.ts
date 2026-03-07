import { nowISO } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
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
		const contact = contacts.find(
			(entry) =>
				entry.peerDisplayName.toLowerCase() === peer.toLowerCase() ||
				entry.peerAgentId === Number.parseInt(peer, 10),
		);
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
		const service = createCliTapMessagingService(ctx, opts, {
			ownerLabel: "tap:permissions-revoke",
		});
		const result = await service.publishGrantSet(
			peer,
			grantSet,
			cmdOpts?.note ?? `Revoked ${grantId}`,
		);

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
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
