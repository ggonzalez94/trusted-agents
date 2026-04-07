import { ValidationError, nowISO } from "trusted-agents-core";
import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, success, verbose } from "../lib/output.js";
import {
	isQueuedTapCommandPending,
	queuedTapCommandPendingFields,
	queuedTapCommandResultFields,
	runOrQueueTapCommand,
} from "../lib/queued-commands.js";
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
		const runtime = await createCliRuntime({ config, opts, ownerLabel: "tap:permissions-revoke" });
		const contacts = await runtime.trustStore.getContacts();
		const contact = contacts.find(
			(entry) =>
				entry.peerDisplayName.toLowerCase() === peer.toLowerCase() ||
				entry.peerAgentId === Number.parseInt(peer, 10),
		);
		if (!contact) {
			error("NOT_FOUND", `Peer not found in contacts: ${peer}`, opts);
			process.exitCode = 4;
			return;
		}
		if (contact.status !== "active") {
			throw new ValidationError(`Cannot send to ${peer}: contact status is "${contact.status}"`);
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
		const outcome = await runOrQueueTapCommand(
			config.dataDir,
			{
				type: "publish-grant-set",
				payload: {
					peer,
					grantSet,
					note,
				},
			},
			async () => await runtime.service.publishGrantSet(peer, grantSet, note),
			{
				requestedBy: "tap:permissions-revoke",
			},
		);

		if (isQueuedTapCommandPending(outcome)) {
			success(
				{
					...queuedTapCommandPendingFields(outcome),
					peer: contact.peerDisplayName,
					grant: match,
				},
				opts,
				startTime,
			);
			return;
		}

		const result = outcome.result;

		success(
			{
				revoked: true,
				...queuedTapCommandResultFields(outcome),
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
