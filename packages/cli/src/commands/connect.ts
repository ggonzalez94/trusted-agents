import { ValidationError, isSelfInvite, parseInviteUrl } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, info, success } from "../lib/output.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

/**
 * `tap connect <invite-url>` — accept an invite by handing it to tapd, then
 * format the daemon's response. The daemon owns the transport, the durable
 * journal, and the synchronous waiter that blocks for the peer's
 * `connection/result`. This command is the thin formatting layer.
 */
export async function connectCommand(
	inviteUrl: string,
	opts: GlobalOptions,
	waitSeconds?: number,
	noWait = false,
	dryRun = false,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);

		// Local validation that doesn't require the daemon: parse the invite,
		// reject self-invites with a clear message. The daemon validates again
		// authoritatively but we surface these early so dry-runs work without a
		// running tapd.
		const invite = parseInviteUrl(inviteUrl);
		if (isSelfInvite(invite, { agentId: config.agentId, chain: config.chain })) {
			throw new ValidationError(
				"Cannot connect to your own invite. Switch to a different TAP identity or --data-dir before accepting it.",
			);
		}

		if (dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					scope: "connection/request",
					peer_agent_id: invite.agentId,
					peer_chain: invite.chain,
					invite_expires_at: new Date(invite.expires * 1000).toISOString(),
					wait_seconds: waitSeconds ?? null,
				},
				opts,
				startTime,
			);
			return;
		}

		// Compute waitMs from the flags:
		// --no-wait => 0 (fire-and-forget)
		// --wait-seconds N => N * 1000
		// default => 30s blocking wait
		const waitMs = noWait ? 0 : waitSeconds !== undefined ? waitSeconds * 1000 : 30_000;

		const client = await TapdClient.forDataDir(config.dataDir);
		const result = await client.connect({ inviteUrl, waitMs });

		if (result.status === "active") {
			success(
				{
					connection_id: result.connectionId,
					peer_name: result.peerName,
					peer_agent_id: result.peerAgentId,
					status: "active",
					receipt: result.receipt,
				},
				opts,
				startTime,
			);
			return;
		}

		// status === "pending"
		if (noWait || waitSeconds === 0) {
			success(
				{
					connection_id: result.connectionId,
					peer_name: result.peerName,
					peer_agent_id: result.peerAgentId,
					status: "pending",
					receipt: result.receipt,
				},
				opts,
				startTime,
			);
			return;
		}

		// Default path: blocking wait timed out. Exit 2.
		info(
			`Connection pending — ${result.peerName} hasn't responded yet. Run 'tap message sync' later to check.`,
			opts,
		);
		error(
			"TIMEOUT",
			`Timed out waiting for connection to become active after ${waitMs / 1000}s.`,
			opts,
		);
		process.exitCode = 2;
	} catch (err) {
		handleCommandError(err, opts);
	}
}
