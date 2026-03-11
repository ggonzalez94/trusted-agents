import {
	type ConnectionResultParams,
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	type InboundResultEnvelope,
	TapMessagingService,
	TransportError,
	type TransportHandlers,
	ValidationError,
	buildConnectionRequest,
	caip2ToChainId,
	createEmptyPermissionState,
	generateConnectionId,
	generateNonce,
	isSelfInvite,
	nowISO,
	parseInviteUrl,
	verifyInvite,
} from "trusted-agents-core";
import type {
	IAgentResolver,
	PermissionGrantSet,
	TransportProvider,
	TransportReceipt,
} from "trusted-agents-core";

export interface ConnectCommandOptions {
	inviteUrl: string;
	privateKey: `0x${string}`;
	agentId: number;
	chain: string;
	dataDir: string;
	resolver: IAgentResolver;
	transport: TransportProvider;
	approveConnection?: (details: {
		peerName: string;
		peerAgentId: number;
		chain: string;
		capabilities: string[];
		requestedGrants: PermissionGrantSet["grants"];
		offeredGrants: PermissionGrantSet["grants"];
	}) => Promise<boolean>;
	notify?: (message: string) => Promise<void>;
	requestedGrants?: PermissionGrantSet;
	offeredGrants?: PermissionGrantSet;
	transportHandlers?: TransportHandlers;
	manageTransportLifecycle?: boolean;
}

export interface ConnectResult {
	success: boolean;
	connectionId?: string;
	peerName?: string;
	status?: "active" | "pending";
	receiptStatus?: TransportReceipt["status"];
	error?: string;
}

const CONNECT_RECEIPT_TIMEOUT_MS = 5_000;

export async function executeConnect(options: ConnectCommandOptions): Promise<ConnectResult> {
	try {
		const { inviteUrl, agentId, chain, dataDir, resolver, transport } = options;
		const chainId = caip2ToChainId(chain);
		if (chainId === null) {
			throw new ValidationError(`Invalid local chain format: ${chain}`);
		}

		const invite = parseInviteUrl(inviteUrl);
		if (isSelfInvite(invite, { agentId, chain })) {
			return {
				success: false,
				error:
					"Cannot connect to your own invite. Switch to a different TAP identity or data dir before accepting it.",
			};
		}

		const manageTransportLifecycle = options.manageTransportLifecycle ?? true;
		if (manageTransportLifecycle) {
			const service = new TapMessagingService(
				{
					config: {
						agentId,
						chain,
						privateKey: options.privateKey,
						dataDir,
						chains: {},
						inviteExpirySeconds: 86_400,
						resolveCacheTtlMs: 60_000,
						resolveCacheMaxEntries: 128,
						xmtpEnv: "production",
					},
					trustStore: new FileTrustStore(dataDir),
					resolver,
					conversationLogger: new FileConversationLogger(dataDir),
					requestJournal: new FileRequestJournal(dataDir),
					transport,
				},
				{
					ownerLabel: "tap:sdk-connect",
				},
			);
			const result = await service.connect({
				inviteUrl,
				requestedGrants: options.requestedGrants,
				offeredGrants: options.offeredGrants,
			});

			if (options.notify) {
				await options.notify(
					`Connection request sent to ${result.peerName}; awaiting offline resolution`,
				);
			}

			return {
				success: true,
				connectionId: result.connectionId,
				peerName: result.peerName,
				status: result.status,
				receiptStatus: result.receipt?.status,
			};
		}

		const peerAgent = await resolver.resolve(invite.agentId, invite.chain);

		const verification = await verifyInvite(invite, {
			expectedSignerAddress: peerAgent.agentAddress,
		});
		if (!verification.valid) {
			return {
				success: false,
				error: verification.error ?? "Invite verification failed",
			};
		}

		if (options.approveConnection) {
			const approved = await options.approveConnection({
				peerName: peerAgent.registrationFile.name,
				peerAgentId: peerAgent.agentId,
				chain: peerAgent.chain,
				capabilities: peerAgent.capabilities,
				requestedGrants: options.requestedGrants?.grants ?? [],
				offeredGrants: options.offeredGrants?.grants ?? [],
			});
			if (!approved) {
				return {
					success: false,
					error: "Connection request was rejected by local approval policy",
				};
			}
		}

		const trustStore = new FileTrustStore(dataDir);
		const requestJournal = new FileRequestJournal(dataDir);
		const existing = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
		if (existing?.status === "active") {
			return {
				success: true,
				connectionId: existing.connectionId,
				peerName: existing.peerDisplayName,
				status: "active",
			};
		}

		const requestedAt = nowISO();
		const connectionId = existing?.connectionId ?? generateConnectionId();
		const requestNonce = generateNonce();
		const rpcRequest = buildConnectionRequest({
			from: { agentId, chain },
			to: { agentId: invite.agentId, chain: invite.chain },
			connectionId,
			...(options.requestedGrants || options.offeredGrants
				? {
						permissionIntent: {
							...(options.requestedGrants
								? { requestedGrants: options.requestedGrants.grants }
								: {}),
							...(options.offeredGrants ? { offeredGrants: options.offeredGrants.grants } : {}),
						},
					}
				: {}),
			nonce: requestNonce,
			inviteNonce: invite.nonce,
			protocolVersion: "1.0",
			timestamp: requestedAt,
		});
		const requestId = String(rpcRequest.id);

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
				initialRequestedGrants: options.requestedGrants,
				initialOfferedGrants: options.offeredGrants,
			},
		};

		if (existing) {
			await trustStore.updateContact(existing.connectionId, nextContact);
		} else {
			await trustStore.addContact(nextContact);
		}

		await requestJournal.putOutbound({
			requestId,
			requestKey: `outbound:${rpcRequest.method}:${requestId}`,
			direction: "outbound",
			kind: "request",
			method: rpcRequest.method,
			peerAgentId: peerAgent.agentId,
			status: "pending",
		});

		let receiptStatus: TransportReceipt["status"] | undefined;
		const existingHandlers = options.transportHandlers ?? {};
		const connectHandlers = buildConnectTransportHandlers(
			{
				agentId,
				chain,
				peerAgentId: peerAgent.agentId,
				peerChain: peerAgent.chain,
				requestId,
			},
			trustStore,
			requestJournal,
			existingHandlers,
		);
		transport.setHandlers(connectHandlers);
		try {
			try {
				const receipt = await transport.send(peerAgent.agentId, rpcRequest, {
					peerAddress: peerAgent.xmtpEndpoint ?? peerAgent.agentAddress,
					timeout: CONNECT_RECEIPT_TIMEOUT_MS,
				});
				receiptStatus = receipt.status;
				const journalEntry = await requestJournal.getByRequestId(requestId);
				if (journalEntry?.status !== "completed") {
					await requestJournal.updateStatus(requestId, "acked");
				}
			} catch (error) {
				if (!(error instanceof TransportError) || !error.message.startsWith("Response timeout")) {
					if (existing) {
						await trustStore.updateContact(existing.connectionId, existing);
					} else {
						await trustStore.removeContact(connectionId);
					}
					await requestJournal.delete(requestId);
					throw error;
				}
			}

			const latestContact = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
			if (!latestContact) {
				const journalEntry = await requestJournal.getByRequestId(requestId);
				if (journalEntry?.status === "completed") {
					return {
						success: false,
						error: `Connection rejected by ${peerAgent.registrationFile.name} (#${peerAgent.agentId})`,
					};
				}
			}

			if (options.notify) {
				await options.notify(
					`Connection request sent to ${peerAgent.registrationFile.name}; awaiting offline resolution`,
				);
			}

			return {
				success: true,
				connectionId: latestContact?.connectionId ?? connectionId,
				peerName: latestContact?.peerDisplayName ?? peerAgent.registrationFile.name,
				status: latestContact?.status === "active" ? "active" : "pending",
				receiptStatus,
			};
		} finally {
			transport.setHandlers(existingHandlers);
		}
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

function buildConnectTransportHandlers(
	context: {
		agentId: number;
		chain: string;
		peerAgentId: number;
		peerChain: string;
		requestId: string;
	},
	trustStore: FileTrustStore,
	requestJournal: FileRequestJournal,
	existingHandlers: TransportHandlers,
): TransportHandlers {
	return {
		onRequest: existingHandlers.onRequest,
		onResult: async (envelope) => {
			const handled = await maybeHandleConnectionResult(
				context,
				envelope,
				trustStore,
				requestJournal,
			);
			if (handled) {
				return { status: "received" };
			}
			if (existingHandlers.onResult) {
				return await existingHandlers.onResult(envelope);
			}
			throw new TransportError("No transport handler registered for results");
		},
	};
}

async function maybeHandleConnectionResult(
	context: {
		agentId: number;
		chain: string;
		peerAgentId: number;
		peerChain: string;
		requestId: string;
	},
	envelope: InboundResultEnvelope,
	trustStore: FileTrustStore,
	requestJournal: FileRequestJournal,
): Promise<boolean> {
	if (envelope.message.method !== "connection/result") {
		return false;
	}

	const result = parseConnectionResult(envelope.message);
	if (result.requestId !== context.requestId) {
		return false;
	}
	if (result.to.agentId !== context.agentId || result.to.chain !== context.chain) {
		throw new ValidationError("Connection result target does not match the local agent");
	}
	if (result.from.agentId !== context.peerAgentId || result.from.chain !== context.peerChain) {
		throw new ValidationError("Connection result sender does not match the invited peer");
	}

	const contact = await trustStore.findByAgentId(result.from.agentId, result.from.chain);
	if (!contact) {
		await requestJournal.updateStatus(result.requestId, "completed");
		return true;
	}

	const matchesPendingRequestId =
		contact.status === "pending" &&
		contact.pending?.direction === "outbound" &&
		contact.pending.requestId === result.requestId;
	if (matchesPendingRequestId && contact.pending?.requestNonce !== result.requestNonce) {
		throw new ValidationError("Connection result returned an unexpected pending nonce");
	}

	const matchesPendingRequest =
		matchesPendingRequestId && contact.pending?.requestNonce === result.requestNonce;
	if (result.status === "accepted") {
		if (matchesPendingRequest) {
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
			await trustStore.updateContact(contact.connectionId, {
				permissions: nextPermissions,
				status: "active",
				pending: undefined,
				lastContactAt: result.timestamp,
			});
		}
	} else if (matchesPendingRequest) {
		await trustStore.removeContact(contact.connectionId);
	}

	await requestJournal.updateStatus(result.requestId, "completed");
	return true;
}

function parseConnectionResult(message: { params?: unknown }): ConnectionResultParams {
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
