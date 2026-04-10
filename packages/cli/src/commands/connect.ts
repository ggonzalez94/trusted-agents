import {
	ValidationError,
	caip2ToChainId,
	isSelfInvite,
	parseInviteUrl,
	verifyInvite,
} from "trusted-agents-core";
import type { ITrustStore } from "trusted-agents-core";
import { createCliRuntime } from "../lib/cli-runtime.js";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { error, info, success } from "../lib/output.js";
import {
	isQueuedTapCommandPending,
	queuedTapCommandPendingFields,
	queuedTapCommandResultFields,
	runOrQueueTapCommand,
} from "../lib/queued-commands.js";
import type { GlobalOptions } from "../types.js";

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
		const chainId = caip2ToChainId(config.chain);
		if (chainId === null) {
			error("VALIDATION_ERROR", `Invalid chain format: ${config.chain}`, opts);
			process.exitCode = 2;
			return;
		}

		const runtime = await createCliRuntime({ config, opts, ownerLabel: "tap:connect" });
		const invite = parseInviteUrl(inviteUrl);
		if (isSelfInvite(invite, { agentId: config.agentId, chain: config.chain })) {
			throw new ValidationError(
				"Cannot connect to your own invite. Switch to a different TAP identity or --data-dir before accepting it.",
			);
		}

		const peerAgent = await runtime.resolver.resolve(invite.agentId, invite.chain);
		const verification = await verifyInvite(invite, {
			expectedSignerAddress: peerAgent.agentAddress,
		});
		if (!verification.valid) {
			error("VALIDATION_ERROR", verification.error ?? "Invite verification failed", opts);
			process.exitCode = 2;
			return;
		}

		info(
			`Preparing connection to ${peerAgent.registrationFile.name} (#${peerAgent.agentId}) on ${peerAgent.chain}`,
			opts,
		);
		info(`Capabilities: ${peerAgent.capabilities.join(", ")}`, opts);
		info(
			"Connect establishes trust only. Publish or request grants after the contact is active.",
			opts,
		);

		if (dryRun) {
			success(
				{
					status: "preview",
					dry_run: true,
					scope: "connection/request",
					peer_name: peerAgent.registrationFile.name,
					peer_agent_id: peerAgent.agentId,
					peer_chain: peerAgent.chain,
					capabilities: peerAgent.capabilities,
					invite_expires_at: new Date(invite.expires * 1000).toISOString(),
					verified: verification.valid,
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

		const { service } = runtime;
		const connectInput = { inviteUrl, waitMs };
		const outcome = await runOrQueueTapCommand(
			config.dataDir,
			{
				type: "connect",
				payload: { inviteUrl },
			},
			async () => await service.connect(connectInput),
			{
				requestedBy: "tap:connect",
			},
		);

		if (isQueuedTapCommandPending(outcome)) {
			// Command was queued (transport held by another process). The executing
			// process is different so the service's internal waiter can't be used here.
			// Fall back to polling for the queued-path only.
			if (waitMs > 0) {
				info(
					`Connect queued. Waiting up to ${waitMs / 1000}s for connection to become active...`,
					opts,
				);
				if (
					await pollForActiveContact(
						runtime.trustStore,
						peerAgent.agentId,
						Math.ceil(waitMs / 1000),
						opts,
						startTime,
					)
				) {
					return; // pollForActiveContact already prints success on active
				}
				info("Timed out waiting. Run 'tap message sync' later to check.", opts);
			}
			success(
				{
					...queuedTapCommandPendingFields(outcome),
					peer_name: peerAgent.registrationFile.name,
					peer_agent_id: peerAgent.agentId,
					status: "pending",
				},
				opts,
				startTime,
			);
			return;
		}

		const result = outcome.result;

		if (result.status === "active") {
			success(
				{
					connection_id: result.connectionId,
					peer_name: result.peerName,
					peer_agent_id: result.peerAgentId,
					status: "active",
					...queuedTapCommandResultFields(outcome),
					receipt: result.receipt,
				},
				opts,
				startTime,
			);
			return;
		}

		// status === "pending"
		if (noWait || waitSeconds === 0) {
			// Caller asked for fire-and-forget — exit 0 with pending.
			success(
				{
					connection_id: result.connectionId,
					peer_name: result.peerName,
					peer_agent_id: result.peerAgentId,
					status: "pending",
					...queuedTapCommandResultFields(outcome),
					receipt: result.receipt,
				},
				opts,
				startTime,
			);
			return;
		}

		// Default path: blocking wait timed out. Exit 2.
		info(
			`Connection pending — ${peerAgent.registrationFile.name} hasn't responded yet. Run 'tap message sync' later to check.`,
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

async function pollForActiveContact(
	trustStore: ITrustStore,
	peerAgentId: number,
	waitSeconds: number,
	opts: GlobalOptions,
	startTime: number,
): Promise<boolean> {
	const pollIntervalMs = 3000;
	const deadline = Date.now() + waitSeconds * 1000;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, pollIntervalMs));
		const contacts = await trustStore.getContacts();
		const match = contacts.find((c) => c.peerAgentId === peerAgentId && c.status === "active");
		if (match) {
			info(`Connection with ${match.peerDisplayName} is now active.`, opts);
			success(
				{
					connection_id: match.connectionId,
					peer_name: match.peerDisplayName,
					peer_agent_id: match.peerAgentId,
					status: "active",
					waited: true,
				},
				opts,
				startTime,
			);
			return true;
		}
	}
	return false;
}
