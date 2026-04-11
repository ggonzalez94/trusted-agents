import { FileRequestJournal } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

interface JournalListFlags {
	direction?: "inbound" | "outbound";
	status?: "queued" | "pending" | "completed";
	method?: string;
}

export async function journalListCommand(
	flags: JournalListFlags,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();
	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const journal = new FileRequestJournal(config.dataDir);
		let entries = await journal.list(flags.direction);
		if (flags.status) {
			entries = entries.filter((e) => e.status === flags.status);
		}
		if (flags.method) {
			entries = entries.filter((e) => e.method === flags.method);
		}

		const rows = entries.map((e) => ({
			request_id: e.requestId,
			direction: e.direction,
			kind: e.kind,
			method: e.method,
			peer_agent_id: e.peerAgentId,
			status: e.status,
			created_at: e.createdAt,
			updated_at: e.updatedAt,
			last_error:
				(e.metadata && typeof e.metadata === "object" && "lastError" in e.metadata
					? (e.metadata as Record<string, unknown>).lastError
					: undefined) ?? null,
		}));

		success({ entries: rows, count: rows.length }, opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
