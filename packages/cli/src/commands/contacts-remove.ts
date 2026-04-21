import { TransportOwnershipError } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, success } from "../lib/output.js";
import { TapdClient, TapdNotRunningError } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

/**
 * `tap contacts remove <connectionId>` — must route through tapd so the
 * revoke-before-delete invariant holds. If tapd is not running, we fail
 * closed rather than deleting the local trust row unilaterally.
 *
 * Rationale: revoke-before-delete is a trust-graph invariant. A local-only
 * delete looks cheaper but leaks trust state that the peer still honors,
 * leading to manual recovery on both sides when the two views diverge.
 * Failing closed forces the operator to bring tapd up first, which is cheap
 * (one command) and preserves the invariant. See `Agents.md` recovery
 * primitives and F3.1 in `docs/superpowers/reviews/2026-04-13-adversarial-review.md`.
 */
export async function contactsRemoveCommand(
	connectionId: string,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);

		let client: TapdClient;
		try {
			client = await TapdClient.forDataDir(config.dataDir);
		} catch (err) {
			if (err instanceof TapdNotRunningError) {
				error(
					"TAPD_NOT_RUNNING",
					"tapd must be running to revoke a contact. Run `tap daemon start` first, then retry.",
					opts,
				);
				process.exitCode = 2;
				return;
			}
			throw err;
		}

		const result = await client.revokeContact(connectionId);
		success({ removed: connectionId, peer: result.peer }, opts, startTime);
		return;
	} catch (err) {
		// Surface the special "owner held elsewhere" error pattern from before.
		if (err instanceof TransportOwnershipError) {
			error(
				"TRANSPORT_ERROR",
				"Contact removal must run through the active TAP owner so revoke can be delivered first.",
				opts,
			);
			process.exitCode = 2;
			return;
		}
		handleCommandError(err, opts);
	}
}
