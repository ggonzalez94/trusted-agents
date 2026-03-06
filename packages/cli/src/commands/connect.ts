import {
	ValidationError,
	buildConnectionRequest,
	caip2ToChainId,
	createEmptyPermissionState,
	generateConnectionId,
	generateNonce,
	nowISO,
	parseInviteUrl,
	verifyInvite,
} from "trusted-agents-core";
import type {
	AgentIdentifier,
	ConnectionRequestParams,
	Contact,
	JsonRpcResponse,
	PermissionGrantSet,
} from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { readGrantFile, summarizeGrantSet } from "../lib/grants.js";
import { error, info, success } from "../lib/output.js";
import { publishGrantSet, sendGrantRequest } from "../lib/permission-workflows.js";
import { promptYesNo } from "../lib/prompt.js";
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
			"Connection establishes trust only; grants are directional and exchanged separately.",
			opts,
		);
		printPermissionIntent(requestedGrants, offeredGrants, opts);

		// Approval check
		if (!autoApprove) {
			info(`Connect to ${peerAgent.registrationFile.name} (#${peerAgent.agentId})?`, opts);
			info("Use --yes to auto-approve", opts);
			// In non-interactive mode (piped), require --yes
			if (!process.stdin.isTTY) {
				error("VALIDATION_ERROR", "Use --yes to approve in non-interactive mode", opts);
				process.exitCode = 1;
				return;
			}
			// Simple y/n prompt
			const answer = await promptYesNo("Proceed? [y/N] ");
			if (!answer) {
				info("Connection cancelled", opts);
				return;
			}
		}

		// Start transport — ensure cleanup on error
		await ctx.transport.start?.();
		try {
			const from: AgentIdentifier = { agentId: config.agentId, chain: config.chain };
			const to: AgentIdentifier = { agentId: invite.agentId, chain: invite.chain };

			const requestParams: ConnectionRequestParams = {
				from,
				to,
				...(requestedGrants || offeredGrants
					? {
							permissionIntent: {
								...(requestedGrants ? { requestedGrants: requestedGrants.grants } : {}),
								...(offeredGrants ? { offeredGrants: offeredGrants.grants } : {}),
							},
						}
					: {}),
				nonce: generateNonce(),
				protocolVersion: "1.0",
				timestamp: nowISO(),
			};

			const rpcRequest = buildConnectionRequest(requestParams);
			const xmtpAddress = peerAgent.xmtpEndpoint ?? peerAgent.agentAddress;

			const response = await ctx.transport.send(peerAgent.agentId, rpcRequest, {
				peerAddress: xmtpAddress,
			});

			// Parse response
			const rpc = response as JsonRpcResponse & { result?: Record<string, unknown> };
			const accepted = rpc.result?.accepted === true || rpc.result?.status === "accepted";
			const status = accepted ? "active" : "pending";
			const connectionId =
				typeof rpc.result?.connectionId === "string" && rpc.result.connectionId.length > 0
					? rpc.result.connectionId
					: undefined;
			if (accepted && !connectionId) {
				throw new ValidationError("Peer accepted the connection without returning a connectionId");
			}

			const contact: Contact = {
				connectionId: connectionId ?? generateConnectionId(),
				peerAgentId: peerAgent.agentId,
				peerChain: peerAgent.chain,
				peerOwnerAddress: peerAgent.ownerAddress,
				peerDisplayName: peerAgent.registrationFile.name,
				peerAgentAddress: peerAgent.agentAddress,
				permissions: createEmptyPermissionState(),
				establishedAt: nowISO(),
				lastContactAt: nowISO(),
				status,
			};

			await ctx.trustStore.addContact(contact);

			if (accepted && offeredGrants) {
				await publishGrantSet({
					config,
					ctx,
					contact,
					grantSet: offeredGrants,
					note: "Initial grant publication from connect",
				});
			}

			if (accepted && requestedGrants) {
				await sendGrantRequest({
					config,
					ctx,
					contact,
					grantSet: requestedGrants,
					note: "Initial grant request from connect",
				});
			}

			success(
				{
					connection_id: connectionId ?? invite.nonce,
					peer_name: peerAgent.registrationFile.name,
					peer_agent_id: peerAgent.agentId,
					status,
					requested_grants: requestedGrants?.grants ?? [],
					offered_grants: offeredGrants?.grants ?? [],
				},
				opts,
				startTime,
			);
		} finally {
			await ctx.transport.stop?.();
		}
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
		info("No initial grant requests or grant publications will be sent.", opts);
		return;
	}

	if (requestedGrants) {
		info("Will request these grants from the peer after connect:", opts);
		for (const line of summarizeGrantSet(requestedGrants)) {
			info(`  - ${line}`, opts);
		}
	}

	if (offeredGrants) {
		info("Will publish these grants to the peer after connect:", opts);
		for (const line of summarizeGrantSet(offeredGrants)) {
			info(`  - ${line}`, opts);
		}
	}
}
