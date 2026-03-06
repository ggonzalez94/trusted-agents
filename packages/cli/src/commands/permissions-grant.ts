import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { readGrantFile } from "../lib/grants.js";
import { findContactForPeer } from "../lib/message-conversations.js";
import { error, success, verbose } from "../lib/output.js";
import { publishGrantSet } from "../lib/permission-workflows.js";
import type { GlobalOptions } from "../types.js";

export async function permissionsGrantCommand(
	peer: string,
	file: string,
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

		const grantSet = await readGrantFile(file);
		verbose(`Publishing ${grantSet.grants.length} grants to ${contact.peerDisplayName}...`, opts);

		await ctx.transport.start?.();
		try {
			const response = await publishGrantSet({
				config,
				ctx,
				contact,
				grantSet,
				note: cmdOpts?.note,
			});

			success(
				{
					published: true,
					peer: contact.peerDisplayName,
					agent_id: contact.peerAgentId,
					grant_count: grantSet.grants.length,
					grants: grantSet.grants,
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
