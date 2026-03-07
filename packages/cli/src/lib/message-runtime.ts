import {
	ACTION_REQUEST,
	ACTION_RESULT,
	CONNECTION_REQUEST,
	CONNECTION_RESULT,
	type ConnectionPermissionIntent,
	type ConnectionRequestParams,
	type ConnectionResultParams,
	type Contact,
	MESSAGE_SEND,
	PERMISSIONS_UPDATE,
	type PermissionsUpdateParams,
	type ProtocolMessage,
	type ResolvedAgent,
	TAP_GRANTS_VERSION,
	type TransportHandlers,
	type TrustedAgentsConfig,
	ValidationError,
	buildConnectionResult,
	createEmptyPermissionState,
	createGrantSet,
	handleConnectionRequest,
} from "trusted-agents-core";
import type { GlobalOptions } from "../types.js";
import type {
	PermissionGrantRequestAction,
	TransferActionRequest,
	TransferActionResponse,
} from "./actions.js";
import {
	buildTransferResponseText,
	parsePermissionGrantRequest,
	parseTransferActionRequest,
	parseTransferActionResponse,
} from "./actions.js";
import type { CliContextWithTransport } from "./context.js";
import { findActiveGrantsByScope, summarizeGrant, summarizeGrantSet } from "./grants.js";
import {
	appendConversationLog,
	buildOutgoingActionResult,
	findUniqueContactForAgentId,
} from "./message-conversations.js";
import { info } from "./output.js";
import { appendPermissionLedgerEntry, getPermissionLedgerPath } from "./permission-ledger.js";
import { storePeerGrantSet } from "./permission-workflows.js";
import { promptYesNo } from "./prompt.js";
import { executeTransferAction } from "./transfers.js";

export interface TransferApprovalContext {
	contact: Contact;
	request: TransferActionRequest;
	activeTransferGrants: ReturnType<typeof findActiveGrantsByScope>;
	ledgerPath: string;
}

export interface MessageRuntimeHooks {
	approveConnection?: (
		peer: ResolvedAgent,
		intent: ConnectionPermissionIntent | undefined,
	) => Promise<boolean>;
	approveTransfer?: (context: TransferApprovalContext) => Promise<boolean>;
}

export interface MessageRuntimeOptions {
	autoApproveConnections: boolean;
	autoApproveActions: boolean;
	emitEvents?: boolean;
	hooks?: MessageRuntimeHooks;
}

export interface MessageRuntime {
	handlers: TransportHandlers;
	drain(): Promise<void>;
}

export function createMessageRuntime(
	config: TrustedAgentsConfig,
	ctx: CliContextWithTransport,
	opts: GlobalOptions,
	options: MessageRuntimeOptions,
): MessageRuntime {
	const emitEvents = options.emitEvents ?? false;
	const pendingTasks = new Set<Promise<void>>();
	const inFlightKeys = new Set<string>();

	const emitEvent = (payload: Record<string, unknown>): void => {
		if (!emitEvents) {
			return;
		}
		process.stdout.write(
			`${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`,
		);
	};

	const enqueue = (key: string, task: () => Promise<void>): void => {
		if (inFlightKeys.has(key)) {
			return;
		}

		inFlightKeys.add(key);
		const promise = task()
			.catch((error: unknown) => {
				info(error instanceof Error ? error.message : String(error), opts);
			})
			.finally(() => {
				inFlightKeys.delete(key);
				pendingTasks.delete(promise);
			});
		pendingTasks.add(promise);
	};

	const handlers: TransportHandlers = {
		onRequest: async (envelope) => {
			const requestKey = buildRequestKey(envelope.senderInboxId, envelope.message);
			const claimed = await ctx.requestJournal.claimInbound({
				requestId: String(envelope.message.id),
				requestKey,
				direction: "inbound",
				kind: "request",
				method: envelope.message.method,
				peerAgentId: envelope.from,
			});

			if (claimed.duplicate && claimed.entry.status === "completed") {
				emitEvent({
					direction: "incoming",
					from: envelope.from,
					method: envelope.message.method,
					id: envelope.message.id,
					receipt_status: "duplicate",
				});
				return { status: "duplicate" };
			}

			if (envelope.message.method === CONNECTION_REQUEST) {
				enqueue(requestKey, async () => {
					await processConnectionRequest(envelope);
				});
				emitEvent({
					direction: "incoming",
					from: envelope.from,
					method: envelope.message.method,
					id: envelope.message.id,
					receipt_status: claimed.duplicate ? "duplicate" : "queued",
				});
				return { status: claimed.duplicate ? "duplicate" : "queued" };
			}

			const contact = await findContactForMessage(ctx, config, envelope.from, envelope.message);
			if (!contact) {
				throw new ValidationError(`No contact found for agent ${envelope.from}`);
			}

			if (envelope.message.method === PERMISSIONS_UPDATE) {
				await handlePermissionsUpdate(contact, envelope.message);
				await ctx.requestJournal.updateStatus(String(envelope.message.id), "completed");
				emitEvent({
					direction: "incoming",
					from: envelope.from,
					method: envelope.message.method,
					id: envelope.message.id,
					receipt_status: claimed.duplicate ? "duplicate" : "received",
				});
				return { status: claimed.duplicate ? "duplicate" : "received" };
			}

			await appendConversationLog(ctx.conversationLogger, contact, envelope.message, "incoming");
			await ctx.trustStore.touchContact(contact.connectionId);

			if (envelope.message.method === MESSAGE_SEND) {
				await ctx.requestJournal.updateStatus(String(envelope.message.id), "completed");
				emitEvent({
					direction: "incoming",
					from: envelope.from,
					method: envelope.message.method,
					id: envelope.message.id,
					receipt_status: claimed.duplicate ? "duplicate" : "received",
				});
				return { status: claimed.duplicate ? "duplicate" : "received" };
			}

			if (envelope.message.method !== ACTION_REQUEST) {
				throw new ValidationError(`Unsupported request method: ${envelope.message.method}`);
			}

			const permissionRequest = parsePermissionGrantRequest(envelope.message);
			if (permissionRequest) {
				await handlePermissionGrantRequest(contact, permissionRequest);
				await ctx.requestJournal.updateStatus(String(envelope.message.id), "completed");
				emitEvent({
					direction: "incoming",
					from: envelope.from,
					method: envelope.message.method,
					id: envelope.message.id,
					receipt_status: claimed.duplicate ? "duplicate" : "received",
				});
				return { status: claimed.duplicate ? "duplicate" : "received" };
			}

			const transferRequest = parseTransferActionRequest(envelope.message);
			if (!transferRequest) {
				throw new ValidationError("Unsupported action request payload");
			}

			enqueue(requestKey, async () => {
				await processTransferRequest(contact, envelope.message, transferRequest);
			});
			emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: claimed.duplicate ? "duplicate" : "queued",
			});
			return { status: claimed.duplicate ? "duplicate" : "queued" };
		},
		onResult: async (envelope) => {
			const requestKey = buildRequestKey(envelope.senderInboxId, envelope.message);
			const claimed = await ctx.requestJournal.claimInbound({
				requestId: String(envelope.message.id),
				requestKey,
				direction: "inbound",
				kind: "result",
				method: envelope.message.method,
				peerAgentId: envelope.from,
			});

			if (claimed.duplicate && claimed.entry.status === "completed") {
				emitEvent({
					direction: "incoming",
					from: envelope.from,
					method: envelope.message.method,
					id: envelope.message.id,
					receipt_status: "duplicate",
				});
				return { status: "duplicate" };
			}

			if (envelope.message.method === CONNECTION_RESULT) {
				await handleConnectionResult(envelope.message);
			} else if (envelope.message.method === ACTION_RESULT) {
				await handleActionResult(envelope.from, envelope.message);
			} else {
				throw new ValidationError(`Unsupported result method: ${envelope.message.method}`);
			}

			await ctx.requestJournal.updateStatus(String(envelope.message.id), "completed");
			emitEvent({
				direction: "incoming",
				from: envelope.from,
				method: envelope.message.method,
				id: envelope.message.id,
				receipt_status: claimed.duplicate ? "duplicate" : "received",
			});
			return { status: claimed.duplicate ? "duplicate" : "received" };
		},
	};

	return {
		handlers,
		async drain(): Promise<void> {
			await Promise.allSettled([...pendingTasks]);
		},
	};

	async function processConnectionRequest(envelope: {
		from: number;
		senderInboxId: string;
		message: ProtocolMessage;
	}): Promise<void> {
		const params = parseConnectionRequest(envelope.message);
		const peer = await ctx.resolver.resolveWithCache(params.from.agentId, params.from.chain);
		const existing = await ctx.trustStore.findByAgentId(peer.agentId, peer.chain);

		if (existing?.status !== "active") {
			const pendingContact = {
				connectionId: existing?.connectionId ?? params.connectionId,
				peerAgentId: peer.agentId,
				peerChain: peer.chain,
				peerOwnerAddress: peer.ownerAddress,
				peerDisplayName: peer.registrationFile.name,
				peerAgentAddress: peer.agentAddress,
				permissions: existing?.permissions ?? createEmptyPermissionState(params.timestamp),
				establishedAt: existing?.establishedAt ?? params.timestamp,
				lastContactAt: params.timestamp,
				status: "pending" as const,
				pending: {
					direction: "inbound" as const,
					requestId: String(envelope.message.id),
					requestNonce: params.nonce,
					requestedAt: params.timestamp,
				},
			};

			if (existing) {
				await ctx.trustStore.updateContact(existing.connectionId, pendingContact);
			} else {
				await ctx.trustStore.addContact(pendingContact);
			}
		}

		const decision = await decideConnection(
			peer,
			params.permissionIntent,
			existing?.status === "active",
		);
		if (decision === null) {
			info(
				`Queued connection request from ${peer.registrationFile.name} (#${peer.agentId}); rerun with --yes or interactively to resolve it`,
				opts,
			);
			return;
		}

		const outcome = await handleConnectionRequest({
			message: envelope.message,
			resolver: ctx.resolver,
			trustStore: ctx.trustStore,
			ownAgent: { agentId: config.agentId, chain: config.chain },
			approve: async () => decision,
		});
		const resultMessage = buildConnectionResult(outcome.result);
		const peerAddress = outcome.peer.xmtpEndpoint ?? outcome.peer.agentAddress;
		await ctx.transport.send(outcome.peer.agentId, resultMessage, {
			peerAddress,
			timeout: 5_000,
		});
		await ctx.requestJournal.putOutbound({
			requestId: String(resultMessage.id),
			requestKey: `outbound:${resultMessage.method}:${String(resultMessage.id)}`,
			direction: "outbound",
			kind: "result",
			method: resultMessage.method,
			peerAgentId: outcome.peer.agentId,
			correlationId: outcome.result.requestId,
			status: "completed",
		});
		await ctx.requestJournal.updateStatus(String(envelope.message.id), "completed");

		if (outcome.result.status === "rejected") {
			const pendingContact = await ctx.trustStore.findByAgentId(
				outcome.peer.agentId,
				outcome.peer.chain,
			);
			if (pendingContact?.status === "pending") {
				await ctx.trustStore.removeContact(pendingContact.connectionId);
			}
		}

		info(
			`${outcome.result.status === "accepted" ? "Accepted" : "Rejected"} connection request from ${outcome.peer.registrationFile.name} (#${outcome.peer.agentId})`,
			opts,
		);
	}

	async function handlePermissionsUpdate(
		contact: Contact,
		message: ProtocolMessage,
	): Promise<void> {
		const update = parsePermissionsUpdate(message);
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
	}

	async function handlePermissionGrantRequest(
		contact: Contact,
		request: PermissionGrantRequestAction,
	): Promise<void> {
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
	}

	async function processTransferRequest(
		contact: Contact,
		message: ProtocolMessage,
		request: TransferActionRequest,
	): Promise<void> {
		const approved = await decideTransfer(contact, request);
		if (approved === null) {
			info(
				`Queued action request ${request.actionId} from ${contact.peerDisplayName}; rerun with --yes-actions or interactively to resolve it`,
				opts,
			);
			return;
		}

		let response: TransferActionResponse;
		if (!approved) {
			response = {
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
		} else {
			try {
				const transfer = await executeTransferAction(config, request);
				response = {
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
			} catch (error: unknown) {
				response = {
					type: "transfer/response",
					actionId: request.actionId,
					asset: request.asset,
					amount: request.amount,
					chain: request.chain,
					toAddress: request.toAddress,
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
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
					rationale: response.error,
				});
			}
		}

		await sendActionResult(contact, String(message.id), response);
		await ctx.requestJournal.updateStatus(String(message.id), "completed");
	}

	async function handleConnectionResult(message: ProtocolMessage): Promise<void> {
		const result = parseConnectionResult(message);
		const contact = await ctx.trustStore.findByAgentId(result.from.agentId, result.from.chain);
		if (contact) {
			if (result.status === "accepted") {
				if (!result.connectionId) {
					throw new ValidationError("Accepted connection result missing connectionId");
				}
				if (contact.connectionId !== result.connectionId) {
					throw new ValidationError("Connection result returned an unexpected connectionId");
				}
				const nextPermissions = contact.pending?.initialOfferedGrants
					? {
							...contact.permissions,
							grantedByMe: contact.pending.initialOfferedGrants,
						}
					: contact.permissions;
				await ctx.trustStore.updateContact(contact.connectionId, {
					permissions: nextPermissions,
					status: "active",
					pending: undefined,
					lastContactAt: result.timestamp,
				});
				info(`Connection accepted by ${contact.peerDisplayName} (#${contact.peerAgentId})`, opts);
			} else {
				await ctx.trustStore.removeContact(contact.connectionId);
				info(`Connection rejected by ${contact.peerDisplayName} (#${contact.peerAgentId})`, opts);
			}
		}

		await ctx.requestJournal.updateStatus(result.requestId, "completed");
	}

	async function handleActionResult(from: number, message: ProtocolMessage): Promise<void> {
		const contact = await findContactForMessage(ctx, config, from, message);
		if (contact) {
			await appendConversationLog(ctx.conversationLogger, contact, message, "incoming");
			await ctx.trustStore.touchContact(contact.connectionId);
		}

		const response = parseTransferActionResponse(message);
		if (response) {
			if (contact) {
				await appendPermissionLedgerEntry(config.dataDir, {
					peer: `${contact.peerDisplayName} (#${contact.peerAgentId})`,
					direction: "local",
					event: `transfer-${response.status}`,
					scope: "transfer/request",
					asset: response.asset,
					amount: response.amount,
					action_id: response.actionId,
					tx_hash: response.txHash,
					decision: response.status,
					rationale: response.error,
				});
			}
			if (response.requestId) {
				await ctx.requestJournal.updateStatus(response.requestId, "completed");
			}
			if (contact) {
				info(
					`Received transfer ${response.status} result from ${contact.peerDisplayName} (#${contact.peerAgentId})`,
					opts,
				);
			}
		}
	}

	async function decideConnection(
		peer: ResolvedAgent,
		intent: ConnectionPermissionIntent | undefined,
		alreadyActive: boolean,
	): Promise<boolean | null> {
		if (alreadyActive) {
			return true;
		}

		if (options.autoApproveConnections) {
			info(`Auto-accepting connection from ${peer.registrationFile.name} (#${peer.agentId})`, opts);
			printConnectionIntent(intent);
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
		printConnectionIntent(intent);

		if (options.hooks?.approveConnection) {
			return await options.hooks.approveConnection(peer, intent);
		}

		if (!process.stdin.isTTY) {
			return null;
		}

		return await promptYesNo("Accept? [y/N] ");
	}

	async function decideTransfer(
		contact: Contact,
		request: TransferActionRequest,
	): Promise<boolean | null> {
		const assetLabel = request.asset === "native" ? "ETH" : "USDC";
		const transferGrants = findActiveGrantsByScope(
			contact.permissions.grantedByMe,
			"transfer/request",
		);
		const ledgerPath = getPermissionLedgerPath(config.dataDir);

		if (options.autoApproveActions) {
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
		info(`Ledger path: ${ledgerPath}`, opts);
		info("The agent should use the grants and ledger as context for this decision.", opts);

		if (options.hooks?.approveTransfer) {
			return await options.hooks.approveTransfer({
				contact,
				request,
				activeTransferGrants: transferGrants,
				ledgerPath,
			});
		}

		if (!process.stdin.isTTY) {
			return null;
		}

		return await promptYesNo("Approve action? [y/N] ");
	}

	async function sendActionResult(
		contact: Contact,
		requestId: string,
		response: TransferActionResponse,
	): Promise<void> {
		const request = buildOutgoingActionResult(
			contact,
			requestId,
			buildTransferResponseText(response),
			response,
			"transfer/request",
			response.status,
		);

		await ctx.transport.send(contact.peerAgentId, request, {
			peerAddress: contact.peerAgentAddress,
			timeout: 5_000,
		});
		await appendConversationLog(ctx.conversationLogger, contact, request, "outgoing");
		await ctx.trustStore.touchContact(contact.connectionId);
		await ctx.requestJournal.putOutbound({
			requestId: String(request.id),
			requestKey: `outbound:${request.method}:${String(request.id)}`,
			direction: "outbound",
			kind: "result",
			method: request.method,
			peerAgentId: contact.peerAgentId,
			correlationId: requestId,
			status: "completed",
		});
	}

	function printConnectionIntent(intent: ConnectionPermissionIntent | undefined): void {
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
}

function buildRequestKey(senderInboxId: string, message: ProtocolMessage): string {
	return `${senderInboxId}:${message.method}:${String(message.id)}`;
}

function parseConnectionRequest(message: ProtocolMessage): ConnectionRequestParams {
	const params = message.params as ConnectionRequestParams | undefined;
	if (
		typeof params?.from?.agentId !== "number" ||
		typeof params.from.chain !== "string" ||
		typeof params.to?.agentId !== "number" ||
		typeof params.to.chain !== "string" ||
		typeof params.connectionId !== "string" ||
		typeof params.nonce !== "string" ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid connection request payload");
	}
	return params;
}

function parseConnectionResult(message: ProtocolMessage): ConnectionResultParams {
	const params = message.params as ConnectionResultParams | undefined;
	if (
		typeof params?.requestId !== "string" ||
		typeof params.requestNonce !== "string" ||
		typeof params.from?.agentId !== "number" ||
		typeof params.from.chain !== "string" ||
		typeof params.to?.agentId !== "number" ||
		typeof params.to.chain !== "string" ||
		(params.status !== "accepted" && params.status !== "rejected") ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid connection result payload");
	}
	return params;
}

function parsePermissionsUpdate(
	message: ProtocolMessage,
): PermissionsUpdateParams & { note?: string } {
	if (typeof message.params !== "object" || message.params === null) {
		throw new ValidationError("Invalid grant publication payload");
	}

	const params = message.params as {
		grantSet?: PermissionsUpdateParams["grantSet"];
		grantor?: PermissionsUpdateParams["grantor"];
		grantee?: PermissionsUpdateParams["grantee"];
		note?: unknown;
		timestamp?: unknown;
	};

	if (
		typeof params.grantSet !== "object" ||
		params.grantSet === null ||
		!Array.isArray(params.grantSet.grants) ||
		typeof params.grantSet.updatedAt !== "string" ||
		params.grantSet.version !== TAP_GRANTS_VERSION ||
		typeof params.grantor?.agentId !== "number" ||
		typeof params.grantor.chain !== "string" ||
		typeof params.grantee?.agentId !== "number" ||
		typeof params.grantee.chain !== "string" ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid grant publication payload");
	}

	return {
		grantSet: params.grantSet,
		grantor: params.grantor,
		grantee: params.grantee,
		note: typeof params.note === "string" && params.note.length > 0 ? params.note : undefined,
		timestamp: params.timestamp,
	};
}

async function findContactForMessage(
	ctx: CliContextWithTransport,
	config: TrustedAgentsConfig,
	from: number,
	message: ProtocolMessage,
): Promise<Contact | null> {
	const metadataConnectionId = extractConnectionId(message);
	if (metadataConnectionId) {
		const contact = await ctx.trustStore.getContact(metadataConnectionId);
		if (contact?.peerAgentId === from) {
			return contact;
		}
	}

	if (message.method === CONNECTION_RESULT) {
		const params = parseConnectionResult(message);
		return await ctx.trustStore.findByAgentId(params.from.agentId, params.from.chain);
	}

	if (message.method === PERMISSIONS_UPDATE) {
		const params = parsePermissionsUpdate(message);
		const peer =
			params.grantor.agentId === config.agentId && params.grantor.chain === config.chain
				? params.grantee
				: params.grantor;
		return await ctx.trustStore.findByAgentId(peer.agentId, peer.chain);
	}

	const contacts = await ctx.trustStore.getContacts();
	return findUniqueContactForAgentId(contacts, from) ?? null;
}

function extractConnectionId(message: ProtocolMessage): string | null {
	if (typeof message.params !== "object" || message.params === null) {
		return null;
	}

	const payload = message.params as {
		message?: {
			metadata?: {
				trustedAgent?: {
					connectionId?: unknown;
				};
			};
		};
	};

	const connectionId = payload.message?.metadata?.trustedAgent?.connectionId;
	return typeof connectionId === "string" && connectionId.length > 0 ? connectionId : null;
}
