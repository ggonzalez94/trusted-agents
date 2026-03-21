import {
	ValidationError,
	caip2ToChainId,
	isSelfInvite,
	parseInviteUrl,
	verifyInvite,
} from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { error, info, success } from "../lib/output.js";
import { promptYesNo } from "../lib/prompt.js";
import {
	isQueuedTapCommandPending,
	queuedTapCommandPendingFields,
	queuedTapCommandResultFields,
	runOrQueueTapCommand,
} from "../lib/queued-commands.js";
import { createCliTapMessagingService } from "../lib/tap-service.js";
import type { GlobalOptions } from "../types.js";

export async function connectCommand(
	inviteUrl: string,
	autoApprove: boolean,
	opts: GlobalOptions,
	waitSeconds?: number,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const chainId = caip2ToChainId(config.chain);
		if (chainId === null) {
			error("VALIDATION_ERROR", `Invalid chain format: ${config.chain}`, opts);
			process.exitCode = 1;
			return;
		}

		const ctx = buildContextWithTransport(config);
		const invite = parseInviteUrl(inviteUrl);
		if (isSelfInvite(invite, { agentId: config.agentId, chain: config.chain })) {
			throw new ValidationError(
				"Cannot connect to your own invite. Switch to a different TAP identity or --data-dir before accepting it.",
			);
		}

		const peerAgent = await ctx.resolver.resolve(invite.agentId, invite.chain);
		const verification = await verifyInvite(invite, {
			expectedSignerAddress: peerAgent.agentAddress,
		});
		if (!verification.valid) {
			error("VALIDATION_ERROR", verification.error ?? "Invite verification failed", opts);
			process.exitCode = 1;
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

		if (!autoApprove) {
			info(
				`Send connection request to ${peerAgent.registrationFile.name} (#${peerAgent.agentId})?`,
				opts,
			);
			info("Use --yes to approve in non-interactive mode", opts);
			if (!process.stdin.isTTY) {
				error("VALIDATION_ERROR", "Use --yes to approve in non-interactive mode", opts);
				process.exitCode = 1;
				return;
			}
			const answer = await promptYesNo("Proceed? [y/N] ");
			if (!answer) {
				info("Connection cancelled", opts);
				return;
			}
		}

		const service = createCliTapMessagingService(ctx, opts, {
			ownerLabel: "tap:connect",
		});
		const connectInput = { inviteUrl };
		const outcome = await runOrQueueTapCommand(
			config.dataDir,
			{
				type: "connect",
				payload: connectInput,
			},
			async () => await service.connect(connectInput),
			{
				requestedBy: "tap:connect",
			},
		);

		if (isQueuedTapCommandPending(outcome)) {
			if (waitSeconds) {
				const pollIntervalMs = 3000;
				const deadline = Date.now() + waitSeconds * 1000;

				info(
					`Connect queued. Waiting up to ${waitSeconds}s for connection to become active...`,
					opts,
				);

				while (Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, pollIntervalMs));
					const contacts = await ctx.trustStore.getContacts();
					const match = contacts.find(
						(c) => c.peerAgentId === peerAgent.agentId && c.status === "active",
					);
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
						return;
					}
				}

				info(`Timed out waiting. Run 'tap message sync' later to check.`, opts);
			}

			success(
				{
					...queuedTapCommandPendingFields(outcome),
					peer_name: peerAgent.registrationFile.name,
					peer_agent_id: peerAgent.agentId,
					status: "queued",
				},
				opts,
				startTime,
			);
			return;
		}

		const result = outcome.result;

		if (waitSeconds && result.status !== "active") {
			const pollIntervalMs = 3000;
			const deadline = Date.now() + waitSeconds * 1000;

			info(`Waiting up to ${waitSeconds}s for connection to become active...`, opts);

			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, pollIntervalMs));

				try {
					await service.syncOnce();
				} catch {
					// Transport may be owned by another process
				}

				const contacts = await ctx.trustStore.getContacts();
				const match = contacts.find(
					(c) => c.peerAgentId === peerAgent.agentId && c.status === "active",
				);
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
					return;
				}
			}

			info(`Timed out waiting for connection. Run 'tap message sync' later to check.`, opts);
		}

		success(
			{
				connection_id: result.connectionId,
				peer_name: result.peerName,
				peer_agent_id: result.peerAgentId,
				status: result.status,
				...queuedTapCommandResultFields(outcome),
				receipt: result.receipt,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}
