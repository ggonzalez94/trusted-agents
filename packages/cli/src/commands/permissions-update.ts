import { assertContactActive, findContactForPeer } from "trusted-agents-core";
import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { readGrantFile } from "../lib/grants.js";
import { error, success, verbose } from "../lib/output.js";
import {
	isQueuedTapCommandPending,
	queuedTapCommandPendingFields,
	queuedTapCommandResultFields,
	runOrQueueTapCommand,
} from "../lib/queued-commands.js";
import type { GlobalOptions } from "../types.js";

type PermissionsDirection = "grant" | "request";

const directionConfig = {
	grant: {
		verb: "Publishing",
		commandType: "publish-grant-set" as const,
		ownerLabel: "tap:permissions-grant",
		successFlag: "published",
		serviceMethod: "publishGrantSet" as const,
	},
	request: {
		verb: "Requesting",
		commandType: "request-grant-set" as const,
		ownerLabel: "tap:permissions-request",
		successFlag: "requested",
		serviceMethod: "requestGrantSet" as const,
	},
};

async function permissionsUpdateCommand(
	direction: PermissionsDirection,
	peer: string,
	file: string,
	opts: GlobalOptions,
	cmdOpts?: { note?: string; dryRun?: boolean },
): Promise<void> {
	const startTime = Date.now();
	const cfg = directionConfig[direction];

	try {
		const config = await loadConfig(opts);
		const runtime = await createCliRuntime({ config, opts, ownerLabel: cfg.ownerLabel });
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

		verbose(
			`${cfg.verb} ${grantSet.grants.length} grants ${direction === "grant" ? "to" : "from"} ${peer}...`,
			opts,
		);
		const outcome = await runOrQueueTapCommand(
			config.dataDir,
			{
				type: cfg.commandType,
				payload: {
					peer,
					grantSet,
					note: cmdOpts?.note,
				},
			},
			async () => await runtime.service[cfg.serviceMethod](peer, grantSet, cmdOpts?.note),
			{
				requestedBy: cfg.ownerLabel,
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
				[cfg.successFlag]: true,
				...queuedTapCommandResultFields(outcome),
				peer: result.peerName,
				agent_id: result.peerAgentId,
				grant_count: result.grantCount,
				grants: grantSet.grants,
				...("actionId" in result ? { action_id: result.actionId } : {}),
				response: result.receipt,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

export async function permissionsGrantCommand(
	peer: string,
	file: string,
	opts: GlobalOptions,
	cmdOpts?: { note?: string; dryRun?: boolean },
): Promise<void> {
	return permissionsUpdateCommand("grant", peer, file, opts, cmdOpts);
}

export async function permissionsRequestCommand(
	peer: string,
	file: string,
	opts: GlobalOptions,
	cmdOpts?: { note?: string; dryRun?: boolean },
): Promise<void> {
	return permissionsUpdateCommand("request", peer, file, opts, cmdOpts);
}
