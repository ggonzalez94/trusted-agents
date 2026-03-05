import type { GlobalOptions } from "../types.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { error, info, success } from "../lib/output.js";
import { exitCodeForError, errorCode } from "../lib/errors.js";
import { promptYesNo } from "../lib/prompt.js";
import {
	buildConnectionRequest,
	caip2ToChainId,
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
} from "trusted-agents-core";

export async function connectCommand(
	inviteUrl: string,
	autoApprove: boolean,
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

		const verification = await verifyInvite(invite, {
			expectedSignerAddress: peerAgent.agentAddress,
		});
		if (!verification.valid) {
			error("VALIDATION_ERROR", verification.error ?? "Invite verification failed", opts);
			process.exitCode = 1;
			return;
		}

		// Approval check
		if (!autoApprove) {
			info(
				`Connect to ${peerAgent.registrationFile.name} (#${peerAgent.agentId}) on ${peerAgent.chain}?`,
				opts,
			);
			info(`Capabilities: ${peerAgent.capabilities.join(", ")}`, opts);
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
				proposedScope: ["message/send"],
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
			const accepted =
				rpc.result?.accepted === true || rpc.result?.status === "accepted";
			const connectionId =
				(typeof rpc.result?.connectionId === "string" && rpc.result.connectionId) ||
				generateConnectionId();
			const status = accepted ? "active" : "pending";

			const contact: Contact = {
				connectionId,
				peerAgentId: peerAgent.agentId,
				peerChain: peerAgent.chain,
				peerOwnerAddress: peerAgent.ownerAddress,
				peerDisplayName: peerAgent.registrationFile.name,
				peerAgentAddress: peerAgent.agentAddress,
				permissions: { "message/send": true },
				establishedAt: nowISO(),
				lastContactAt: nowISO(),
				status,
			};

			await ctx.trustStore.addContact(contact);

			success(
				{
					connection_id: connectionId,
					peer_name: peerAgent.registrationFile.name,
					peer_agent_id: peerAgent.agentId,
					status,
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

