import {
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
	PermissionGrantSet,
} from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { readGrantFile, summarizeGrantSet } from "../lib/grants.js";
import { error, info, success } from "../lib/output.js";
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

		const existing = await ctx.trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
		if (existing?.status === "active") {
			success(
				{
					connection_id: existing.connectionId,
					peer_name: existing.peerDisplayName,
					peer_agent_id: existing.peerAgentId,
					status: existing.status,
				},
				opts,
				startTime,
			);
			return;
		}

		const from: AgentIdentifier = { agentId: config.agentId, chain: config.chain };
		const to: AgentIdentifier = { agentId: invite.agentId, chain: invite.chain };
		const requestedAt = nowISO();
		const connectionId = existing?.connectionId ?? generateConnectionId();
		const requestNonce = generateNonce();
		const requestParams: ConnectionRequestParams = {
			from,
			to,
			connectionId,
			...(requestedGrants || offeredGrants
				? {
						permissionIntent: {
							...(requestedGrants ? { requestedGrants: requestedGrants.grants } : {}),
							...(offeredGrants ? { offeredGrants: offeredGrants.grants } : {}),
						},
					}
				: {}),
			nonce: requestNonce,
			protocolVersion: "1.0",
			timestamp: requestedAt,
		};

		const rpcRequest = buildConnectionRequest(requestParams);
		const requestId = String(rpcRequest.id);

		await ctx.transport.start?.();
		try {
			const receipt = await ctx.transport.send(peerAgent.agentId, rpcRequest, {
				peerAddress: peerAgent.xmtpEndpoint ?? peerAgent.agentAddress,
			});

			const nextContact = {
				connectionId,
				peerAgentId: peerAgent.agentId,
				peerChain: peerAgent.chain,
				peerOwnerAddress: peerAgent.ownerAddress,
				peerDisplayName: peerAgent.registrationFile.name,
				peerAgentAddress: peerAgent.agentAddress,
				permissions: existing?.permissions ?? createEmptyPermissionState(requestedAt),
				establishedAt: existing?.establishedAt ?? requestedAt,
				lastContactAt: requestedAt,
				status: "pending" as const,
				pending: {
					direction: "outbound" as const,
					requestId,
					requestNonce,
					requestedAt,
					inviteNonce: invite.nonce,
					initialRequestedGrants: requestedGrants,
					initialOfferedGrants: offeredGrants,
				},
			};

			if (existing) {
				await ctx.trustStore.updateContact(existing.connectionId, nextContact);
			} else {
				await ctx.trustStore.addContact(nextContact);
			}

			await ctx.requestJournal.putOutbound({
				requestId,
				requestKey: `outbound:${rpcRequest.method}:${requestId}`,
				direction: "outbound",
				kind: "request",
				method: rpcRequest.method,
				peerAgentId: peerAgent.agentId,
				status: "acked",
			});

			success(
				{
					connection_id: connectionId,
					peer_name: peerAgent.registrationFile.name,
					peer_agent_id: peerAgent.agentId,
					status: "pending",
					receipt,
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
