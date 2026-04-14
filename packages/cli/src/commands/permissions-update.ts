import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { readGrantFile } from "../lib/grants.js";
import { success, verbose } from "../lib/output.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

type PermissionsDirection = "grant" | "request";

async function permissionsUpdateCommand(
	direction: PermissionsDirection,
	peer: string,
	file: string,
	opts: GlobalOptions,
	cmdOpts?: { note?: string; dryRun?: boolean },
): Promise<void> {
	const startTime = Date.now();
	const verb = direction === "grant" ? "Publishing" : "Requesting";
	const successFlag = direction === "grant" ? "published" : "requested";

	try {
		const config = await loadConfig(opts);
		const grantSet = await readGrantFile(file);

		if (cmdOpts?.dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					scope: "permissions/update",
					peer,
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
			`${verb} ${grantSet.grants.length} grants ${direction === "grant" ? "to" : "from"} ${peer}...`,
			opts,
		);

		const client = await TapdClient.forDataDir(config.dataDir);
		const result =
			direction === "grant"
				? await client.publishGrants({ peer, grantSet, note: cmdOpts?.note })
				: await client.requestGrants({ peer, grantSet, note: cmdOpts?.note });

		success(
			{
				[successFlag]: true,
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
