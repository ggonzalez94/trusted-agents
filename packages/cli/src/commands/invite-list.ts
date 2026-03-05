import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isExpired } from "trusted-agents-core";
import type { PendingInvite } from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { error, success } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";

export async function inviteListCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const filePath = join(config.dataDir, "pending-invites.json");

		let invites: PendingInvite[] = [];
		if (existsSync(filePath)) {
			const raw = readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(raw) as { invites?: PendingInvite[] };
			invites = (parsed.invites ?? []).filter(
				(i) => i.status === "unused" && !isExpired(i.expiresAt),
			);
		}

		success({ invites }, opts, startTime);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
