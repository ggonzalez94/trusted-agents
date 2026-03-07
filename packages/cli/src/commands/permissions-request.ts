import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { readGrantFile } from "../lib/grants.js";
import { error, success, verbose } from "../lib/output.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
import type { GlobalOptions } from "../types.js";

export async function permissionsRequestCommand(
	peer: string,
	file: string,
	opts: GlobalOptions,
	cmdOpts?: { note?: string },
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const ctx = buildContextWithTransport(config);
		const grantSet = await readGrantFile(file);
		verbose(`Requesting ${grantSet.grants.length} grants from ${peer}...`, opts);
		const service = createCliTapMessagingService(ctx, opts, {
			ownerLabel: "tap:permissions-request",
		});
		const result = await service.requestGrantSet(peer, grantSet, cmdOpts?.note);

		success(
			{
				requested: true,
				peer: result.peerName,
				agent_id: result.peerAgentId,
				grant_count: result.grantCount,
				grants: grantSet.grants,
				action_id: result.actionId,
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
