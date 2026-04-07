import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { readGrantFile } from "../lib/grants.js";
import { assertContactActive, findContactForPeer } from "../lib/message-conversations.js";
import { error, success, verbose } from "../lib/output.js";
import {
	isQueuedTapCommandPending,
	queuedTapCommandPendingFields,
	queuedTapCommandResultFields,
	runOrQueueTapCommand,
} from "../lib/queued-commands.js";
import type { GlobalOptions } from "../types.js";

export async function permissionsGrantCommand(
	peer: string,
	file: string,
	opts: GlobalOptions,
	cmdOpts?: { note?: string; dryRun?: boolean },
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const runtime = await createCliRuntime({ config, opts, ownerLabel: "tap:permissions-grant" });
		const grantSet = await readGrantFile(file);
		const contact = findContactForPeer(await runtime.trustStore.getContacts(), peer);
		if (!contact) {
			error("NOT_FOUND", `Peer not found in contacts: ${peer}`, opts);
			process.exitCode = 4;
			return;
		}
		assertContactActive(contact, peer);

		if (cmdOpts?.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					scope: "permissions/update",
					peer: contact.peerDisplayName,
					agent_id: contact.peerAgentId,
					connection_id: contact.connectionId,
					grant_count: grantSet.grants.length,
					grants: grantSet.grants,
					...(cmdOpts.note ? { note: cmdOpts.note } : {}),
				},
				opts,
				startTime,
			);
			return;
		}

		verbose(`Publishing ${grantSet.grants.length} grants to ${peer}...`, opts);
		const outcome = await runOrQueueTapCommand(
			config.dataDir,
			{
				type: "publish-grant-set",
				payload: {
					peer,
					grantSet,
					note: cmdOpts?.note,
				},
			},
			async () => await runtime.service.publishGrantSet(peer, grantSet, cmdOpts?.note),
			{
				requestedBy: "tap:permissions-grant",
			},
		);

		if (isQueuedTapCommandPending(outcome)) {
			success(
				{
					...queuedTapCommandPendingFields(outcome),
					peer,
					grant_count: grantSet.grants.length,
					grants: grantSet.grants,
				},
				opts,
				startTime,
			);
			return;
		}

		const result = outcome.result;

		success(
			{
				published: true,
				...queuedTapCommandResultFields(outcome),
				peer: result.peerName,
				agent_id: result.peerAgentId,
				grant_count: result.grantCount,
				grants: grantSet.grants,
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
