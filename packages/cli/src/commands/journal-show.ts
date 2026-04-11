import { FileRequestJournal } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function journalShowCommand(requestId: string, opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();
	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const journal = new FileRequestJournal(config.dataDir);
		const entry = await journal.getByRequestId(requestId);
		if (!entry) {
			error("NOT_FOUND", `Journal entry not found: ${requestId}`, opts);
			process.exitCode = 4;
			return;
		}
		success(
			{
				request_id: entry.requestId,
				request_key: entry.requestKey,
				direction: entry.direction,
				kind: entry.kind,
				method: entry.method,
				peer_agent_id: entry.peerAgentId,
				correlation_id: entry.correlationId ?? null,
				status: entry.status,
				metadata: entry.metadata ?? null,
				created_at: entry.createdAt,
				updated_at: entry.updatedAt,
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
