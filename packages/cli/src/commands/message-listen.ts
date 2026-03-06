import {
	CONNECTION_REQUEST,
	CONNECTION_UPDATE_GRANTS,
	type ConnectionPermissionIntent,
	type ConnectionUpdateGrantsParams,
	type Contact,
	MESSAGE_ACTION_REQUEST,
	PermissionError,
	type PermissionGrantSet,
	type ProtocolMessage,
	type ProtocolResponse,
	type ResolvedAgent,
	TAP_GRANTS_VERSION,
	type TrustedAgentsConfig,
	ValidationError,
	createGrantSet,
	handleConnectionRequest,
} from "trusted-agents-core";
import type {
	PermissionGrantRequestAction,
	TransferActionRequest,
	TransferActionResponse,
} from "../lib/actions.js";
import {
	buildTransferResponseText,
	parsePermissionGrantRequest,
	parseTransferActionRequest,
} from "../lib/actions.js";
import { loadConfig } from "../lib/config-loader.js";
import { buildContextWithTransport } from "../lib/context.js";
import { errorCode, exitCodeForError } from "../lib/errors.js";
import { findActiveGrantsByScope, summarizeGrant, summarizeGrantSet } from "../lib/grants.js";
import {
	appendConversationLog,
	buildOutgoingActionResponse,
	findUniqueContactForAgentId,
} from "../lib/message-conversations.js";
import { error, info } from "../lib/output.js";
import { appendPermissionLedgerEntry, getPermissionLedgerPath } from "../lib/permission-ledger.js";
import { storePeerGrantSet } from "../lib/permission-workflows.js";
import { promptYesNo } from "../lib/prompt.js";
import { executeTransferAction } from "../lib/transfers.js";
import type { GlobalOptions } from "../types.js";

export interface TransferApprovalContext {
	contact: Contact;
	request: TransferActionRequest;
	activeTransferGrants: ReturnType<typeof findActiveGrantsByScope>;
	ledgerPath: string;
}

export interface MessageListenerHooks {
	approveConnection?: (
		peer: ResolvedAgent,
		intent: ConnectionPermissionIntent | undefined,
	) => Promise<boolean>;
	approveTransfer?: (context: TransferApprovalContext) => Promise<boolean>;
	announce?: boolean;
}

export interface MessageListenerSession {
	stop(): Promise<void>;
}

export async function messageListenCommand(
	opts: GlobalOptions,
	cmdOpts?: { yes?: boolean; yesActions?: boolean },
): Promise<void> {
	try {
		const session = await createMessageListenerSession(opts, cmdOpts);

		const shutdown = async () => {
			info("\nShutting down...", opts);
			await session.stop();
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		await new Promise(() => {});
	} catch (err) {
		error(errorCode(err), err instanceof Error ? err.message : String(err), opts);
		process.exitCode = exitCodeForError(err);
	}
}

export async function createMessageListenerSession(
	opts: GlobalOptions,
	cmdOpts?: { yes?: boolean; yesActions?: boolean },
	hooks?: MessageListenerHooks,
): Promise<MessageListenerSession> {
	const config = await loadConfig(opts);
	const ctx = buildContextWithTransport(config);
	const autoApprove = cmdOpts?.yes ?? false;
	const autoApproveActions = cmdOpts?.yesActions ?? false;

	if (hooks?.announce !== false) {
		info("Listening for incoming messages... (Ctrl+C to stop)", opts);
	}

	ctx.transport.onMessage(async (from, message) => {
		if (message.method === CONNECTION_REQUEST) {
			return handleConnectionRequest({
				message,
				resolver: ctx.resolver,
				trustStore: ctx.trustStore,
				ownAgent: { agentId: config.agentId, chain: config.chain },
				approve: async (peer: ResolvedAgent, intent: ConnectionPermissionIntent | undefined) => {
					if (autoApprove) {
						info(
							`Auto-accepting connection from ${peer.registrationFile.name} (#${peer.agentId})`,
							opts,
						);
						info(`Capabilities: ${peer.capabilities.join(", ")}`, opts);
						info(
							"Connection establishes trust only; any grants requested or offered are exchanged separately.",
							opts,
						);
						printConnectionIntent(intent, opts);
						return true;
					}

					info(
						`Connection request from ${peer.registrationFile.name} (#${peer.agentId}) on ${peer.chain}`,
						opts,
					);
					info(`Capabilities: ${peer.capabilities.join(", ")}`, opts);
					info(
						"Connection establishes trust only; any grants requested or offered are exchanged separately.",
						opts,
					);
					printConnectionIntent(intent, opts);

					if (hooks?.approveConnection) {
						return await hooks.approveConnection(peer, intent);
					}

					return await promptYesNo("Accept? [y/N] ");
				},
			});
		}

		try {
			const contacts = await ctx.trustStore.getContacts();
			const contact = findUniqueContactForAgentId(contacts, from);
			if (!contact) {
				return {
					jsonrpc: "2.0" as const,
					id: message.id,
					error: { code: -32001, message: `No active contact found for agent ${from}` },
				};
			}

			let response: ProtocolResponse;
			if (message.method === CONNECTION_UPDATE_GRANTS) {
				response = await handleGrantPublication(contact, message, config, ctx, opts);
			} else {
				await appendConversationLog(ctx.conversationLogger, contact, message, "incoming");
				await ctx.trustStore.touchContact(contact.connectionId);

				if (message.method === MESSAGE_ACTION_REQUEST) {
					response = await handleActionRequest(
						contact,
						message,
						autoApproveActions,
						config,
						ctx.transport,
						ctx.conversationLogger,
						ctx.trustStore,
						opts,
						hooks?.approveTransfer,
					);
				} else {
					response = {
						jsonrpc: "2.0" as const,
						id: message.id,
						result: { received: true },
					};
				}
			}

			const line = JSON.stringify({
				timestamp: new Date().toISOString(),
				from,
				method: message.method,
				id: message.id,
				params: message.params,
				...(response.error ? { error: response.error } : { result: response.result }),
			});
			process.stdout.write(`${line}\n`);

			return response;
		} catch (err) {
			const messageText = err instanceof Error ? err.message : String(err);
			return {
				jsonrpc: "2.0" as const,
				id: message.id,
				error: {
					code:
						err instanceof PermissionError
							? -32003
							: err instanceof ValidationError
								? -32602
								: -32603,
					message: messageText,
				},
			};
		}
	});

	await ctx.transport.start?.();

	return {
		stop: async () => {
			await ctx.transport.stop?.();
		},
	};
}

async function handleGrantPublication(
	contact: Contact,
	message: ProtocolMessage,
	config: TrustedAgentsConfig,
	ctx: ReturnType<typeof buildContextWithTransport>,
	opts: GlobalOptions,
): Promise<ProtocolResponse> {
	const update = parseGrantPublication(message);
	if (!update) {
		return {
			jsonrpc: "2.0" as const,
			id: message.id,
			error: { code: -32602, message: "Invalid grant publication payload" },
		};
	}

	await storePeerGrantSet({
		config,
		ctx,
		contact,
		grantSet: update.grantSet,
		note: update.note,
	});
	await ctx.trustStore.touchContact(contact.connectionId);

	info(`Grant update from ${contact.peerDisplayName} (#${contact.peerAgentId})`, opts);
	for (const line of summarizeGrantSet(update.grantSet)) {
		info(`  - ${line}`, opts);
	}
	if (update.note) {
		info(`Note: ${update.note}`, opts);
	}

	return {
		jsonrpc: "2.0" as const,
		id: message.id,
		result: {
			received: true,
			grant_count: update.grantSet.grants.length,
		},
	};
}

async function handleActionRequest(
	contact: Contact,
	message: ProtocolMessage,
	autoApproveActions: boolean,
	config: TrustedAgentsConfig,
	transport: ReturnType<typeof buildContextWithTransport>["transport"],
	conversationLogger: ReturnType<typeof buildContextWithTransport>["conversationLogger"],
	trustStore: ReturnType<typeof buildContextWithTransport>["trustStore"],
	opts: GlobalOptions,
	approveTransfer?: MessageListenerHooks["approveTransfer"],
): Promise<ProtocolResponse> {
	const transferRequest = parseTransferActionRequest(message);
	if (transferRequest) {
		return await handleTransferActionRequest(
			contact,
			transferRequest,
			message,
			autoApproveActions,
			config,
			transport,
			conversationLogger,
			trustStore,
			opts,
			approveTransfer,
		);
	}

	const permissionRequest = parsePermissionGrantRequest(message);
	if (permissionRequest) {
		return await handlePermissionGrantRequest(contact, permissionRequest, config, opts, message.id);
	}

	return {
		jsonrpc: "2.0" as const,
		id: message.id,
		error: { code: -32602, message: "Unsupported action request payload" },
	};
}

async function handlePermissionGrantRequest(
	contact: Contact,
	request: PermissionGrantRequestAction,
	config: TrustedAgentsConfig,
	opts: GlobalOptions,
	messageId: ProtocolMessage["id"],
): Promise<ProtocolResponse> {
	info(`Grant request from ${contact.peerDisplayName} (#${contact.peerAgentId})`, opts);
	for (const line of summarizeGrantSet(createGrantSet(request.grants))) {
		info(`  - ${line}`, opts);
	}
	if (request.note) {
		info(`Note: ${request.note}`, opts);
	}

	await appendPermissionLedgerEntry(config.dataDir, {
		peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
		direction: "local",
		event: "grant-request-received",
		action_id: request.actionId,
		note: request.note,
	});

	return {
		jsonrpc: "2.0" as const,
		id: messageId,
		result: {
			received: true,
			actionId: request.actionId,
			requested_grant_count: request.grants.length,
		},
	};
}

async function handleTransferActionRequest(
	contact: Contact,
	request: TransferActionRequest,
	message: ProtocolMessage,
	autoApproveActions: boolean,
	config: TrustedAgentsConfig,
	transport: ReturnType<typeof buildContextWithTransport>["transport"],
	conversationLogger: ReturnType<typeof buildContextWithTransport>["conversationLogger"],
	trustStore: ReturnType<typeof buildContextWithTransport>["trustStore"],
	opts: GlobalOptions,
	approveTransfer?: MessageListenerHooks["approveTransfer"],
): Promise<ProtocolResponse> {
	const approved = await approveTransferRequest(
		contact,
		request,
		config.dataDir,
		autoApproveActions,
		opts,
		approveTransfer,
	);
	if (!approved) {
		const rejected: TransferActionResponse = {
			type: "transfer/response",
			actionId: request.actionId,
			asset: request.asset,
			amount: request.amount,
			chain: request.chain,
			toAddress: request.toAddress,
			status: "rejected",
			error: "Action rejected by agent",
		};
		await appendPermissionLedgerEntry(config.dataDir, {
			peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
			direction: "granted-by-me",
			event: "transfer-rejected",
			scope: "transfer/request",
			asset: request.asset,
			amount: request.amount,
			action_id: request.actionId,
			decision: "rejected",
			rationale: "Rejected at runtime by agent decision",
		});
		await notifyActionResponse(contact, rejected, transport, conversationLogger, trustStore);
		return {
			jsonrpc: "2.0" as const,
			id: message.id,
			error: { code: -32002, message: "Action rejected by agent" },
		};
	}

	try {
		const transfer = await executeTransferAction(config, request);
		const completed: TransferActionResponse = {
			type: "transfer/response",
			actionId: request.actionId,
			asset: request.asset,
			amount: request.amount,
			chain: request.chain,
			toAddress: request.toAddress,
			status: "completed",
			txHash: transfer.txHash,
		};
		await appendPermissionLedgerEntry(config.dataDir, {
			peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
			direction: "granted-by-me",
			event: "transfer-completed",
			scope: "transfer/request",
			asset: request.asset,
			amount: request.amount,
			action_id: request.actionId,
			tx_hash: transfer.txHash,
			decision: "approved",
			rationale: "Approved at runtime by agent decision",
		});
		const notified = await notifyActionResponse(
			contact,
			completed,
			transport,
			conversationLogger,
			trustStore,
		);
		return {
			jsonrpc: "2.0" as const,
			id: message.id,
			result: {
				actionId: completed.actionId,
				status: completed.status,
				txHash: completed.txHash,
				notified,
			},
		};
	} catch (err) {
		const failed: TransferActionResponse = {
			type: "transfer/response",
			actionId: request.actionId,
			asset: request.asset,
			amount: request.amount,
			chain: request.chain,
			toAddress: request.toAddress,
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
		await appendPermissionLedgerEntry(config.dataDir, {
			peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
			direction: "granted-by-me",
			event: "transfer-failed",
			scope: "transfer/request",
			asset: request.asset,
			amount: request.amount,
			action_id: request.actionId,
			decision: "approved",
			rationale: failed.error,
		});
		await notifyActionResponse(contact, failed, transport, conversationLogger, trustStore);
		return {
			jsonrpc: "2.0" as const,
			id: message.id,
			error: { code: -32603, message: failed.error ?? "Transfer failed" },
		};
	}
}

async function approveTransferRequest(
	contact: Contact,
	request: TransferActionRequest,
	dataDir: string,
	autoApproveActions: boolean,
	opts: GlobalOptions,
	approveTransfer?: MessageListenerHooks["approveTransfer"],
): Promise<boolean> {
	const assetLabel = request.asset === "native" ? "ETH" : "USDC";
	const transferGrants = findActiveGrantsByScope(
		contact.permissions.grantedByMe,
		"transfer/request",
	);

	if (autoApproveActions) {
		info(
			`Auto-approving ${request.amount} ${assetLabel} on ${request.chain} for ${contact.peerDisplayName}`,
			opts,
		);
		return true;
	}

	info(
		`Action request from ${contact.peerDisplayName} (#${contact.peerAgentId}): send ${request.amount} ${assetLabel} on ${request.chain} to ${request.toAddress}`,
		opts,
	);
	if (request.note) {
		info(`Note: ${request.note}`, opts);
	}

	info("Published transfer grants to this peer:", opts);
	if (transferGrants.length === 0) {
		info("  - (none)", opts);
	} else {
		for (const grant of transferGrants) {
			info(`  - ${summarizeGrant(grant)}`, opts);
		}
	}
	info(`Ledger path: ${getPermissionLedgerPath(dataDir)}`, opts);
	info("The agent should use the grants and ledger as context for this decision.", opts);

	if (approveTransfer) {
		return await approveTransfer({
			contact,
			request,
			activeTransferGrants: transferGrants,
			ledgerPath: getPermissionLedgerPath(dataDir),
		});
	}

	if (!process.stdin.isTTY) {
		throw new PermissionError(
			"Use --yes-actions to approve action requests in non-interactive mode",
		);
	}

	return await promptYesNo("Approve action? [y/N] ");
}

async function notifyActionResponse(
	contact: Contact,
	response: TransferActionResponse,
	transport: ReturnType<typeof buildContextWithTransport>["transport"],
	conversationLogger: ReturnType<typeof buildContextWithTransport>["conversationLogger"],
	trustStore: ReturnType<typeof buildContextWithTransport>["trustStore"],
): Promise<boolean> {
	const request = buildOutgoingActionResponse(
		contact,
		buildTransferResponseText(response),
		response,
		"transfer/request",
	);

	try {
		await transport.send(contact.peerAgentId, request, {
			peerAddress: contact.peerAgentAddress,
			timeout: 5_000,
		});
		await appendConversationLog(conversationLogger, contact, request, "outgoing");
		await trustStore.touchContact(contact.connectionId);
		return true;
	} catch {
		return false;
	}
}

function printConnectionIntent(
	intent: ConnectionPermissionIntent | undefined,
	opts: GlobalOptions,
): void {
	if (!intent?.requestedGrants?.length && !intent?.offeredGrants?.length) {
		info("No initial grant requests or grant publications were included.", opts);
		return;
	}

	if (intent.requestedGrants?.length) {
		info("Peer intends to request these grants after connect:", opts);
		for (const grant of intent.requestedGrants) {
			info(`  - ${summarizeGrant(grant)}`, opts);
		}
	}

	if (intent.offeredGrants?.length) {
		info("Peer intends to publish these grants after connect:", opts);
		for (const grant of intent.offeredGrants) {
			info(`  - ${summarizeGrant(grant)}`, opts);
		}
	}
}

function parseGrantPublication(
	message: ProtocolMessage,
): (ConnectionUpdateGrantsParams & { note?: string }) | null {
	if (typeof message.params !== "object" || message.params === null) {
		return null;
	}

	const params = message.params as {
		grantSet?: PermissionGrantSet;
		grantor?: unknown;
		grantee?: unknown;
		note?: unknown;
		timestamp?: unknown;
	};

	if (
		typeof params.grantSet !== "object" ||
		params.grantSet === null ||
		!Array.isArray(params.grantSet.grants) ||
		typeof params.grantSet.updatedAt !== "string" ||
		params.grantSet.version !== TAP_GRANTS_VERSION ||
		typeof params.timestamp !== "string"
	) {
		return null;
	}

	return {
		grantSet: params.grantSet,
		grantor: params.grantor as ConnectionUpdateGrantsParams["grantor"],
		grantee: params.grantee as ConnectionUpdateGrantsParams["grantee"],
		note: typeof params.note === "string" && params.note.length > 0 ? params.note : undefined,
		timestamp: params.timestamp,
	};
}
