import {
	ValidationError,
	caip2ToChainId,
	isSelfInvite,
	parseInviteUrl,
	verifyInvite,
} from "trusted-agents-core";
import type { PermissionGrantSet } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { readGrantFile, summarizeGrantSet } from "../lib/grants.js";
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
	cmdOpts: {
		requestGrantsFile?: string;
		grantFile?: string;
	},
	opts: GlobalOptions,
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
		const requestedGrants = cmdOpts.requestGrantsFile
			? await readGrantFile(cmdOpts.requestGrantsFile)
			: undefined;
		const offeredGrants = cmdOpts.grantFile ? await readGrantFile(cmdOpts.grantFile) : undefined;

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
			"Connection is now asynchronous. The peer only needs to receive the request; acceptance arrives later as a separate result.",
			opts,
		);
		printPermissionIntent(requestedGrants, offeredGrants, opts);

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
		const connectInput = {
			inviteUrl,
			requestedGrants,
			offeredGrants,
		};
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
			success(
				{
					...queuedTapCommandPendingFields(outcome),
					peer_name: peerAgent.registrationFile.name,
					peer_agent_id: peerAgent.agentId,
					status: "queued",
					requested_grants: requestedGrants?.grants ?? [],
					offered_grants: offeredGrants?.grants ?? [],
				},
				opts,
				startTime,
			);
			return;
		}

		const result = outcome.result;

		success(
			{
				connection_id: result.connectionId,
				peer_name: result.peerName,
				peer_agent_id: result.peerAgentId,
				status: result.status,
				...queuedTapCommandResultFields(outcome),
				receipt: result.receipt,
				requested_grants: result.requestedGrants,
				offered_grants: result.offeredGrants,
			},
			opts,
			startTime,
		);
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

function printPermissionIntent(
	requestedGrants: PermissionGrantSet | undefined,
	offeredGrants: PermissionGrantSet | undefined,
	opts: GlobalOptions,
): void {
	if (!requestedGrants && !offeredGrants) {
		info(
			"No initial grant requests or grant publications will be sent with the connect request.",
			opts,
		);
		return;
	}

	if (requestedGrants) {
		info("Will include these requested grants in the connection request:", opts);
		for (const line of summarizeGrantSet(requestedGrants)) {
			info(`  - ${line}`, opts);
		}
	}

	if (offeredGrants) {
		info("Will include these offered grants in the connection request:", opts);
		for (const line of summarizeGrantSet(offeredGrants)) {
			info(`  - ${line}`, opts);
		}
	}
}
