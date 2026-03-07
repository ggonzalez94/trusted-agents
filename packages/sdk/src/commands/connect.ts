import {
	FileRequestJournal,
	FileTrustStore,
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
}

export interface ConnectResult {
	success: boolean;
	connectionId?: string;
	peerName?: string;
	status?: "active" | "pending";
	receiptStatus?: TransportReceipt["status"];
	error?: string;
}

export async function executeConnect(options: ConnectCommandOptions): Promise<ConnectResult> {
	try {
		const { inviteUrl, agentId, chain, dataDir, resolver, transport } = options;
		const chainId = caip2ToChainId(chain);
		if (chainId === null) {
			return {
				success: false,
				error: `Invalid local chain format: ${chain}`,
			};
		}

		const invite = parseInviteUrl(inviteUrl);
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
		const existing = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
		if (existing?.status === "active") {
			return {
				success: true,
				connectionId: existing.connectionId,
				peerName: existing.peerDisplayName,
				status: "active",
			};
		}

		const from: AgentIdentifier = { agentId, chain };
		const to: AgentIdentifier = { agentId: invite.agentId, chain: invite.chain };
		const connectionId = existing?.connectionId ?? generateConnectionId();
		const requestNonce = generateNonce();
		const requestedAt = nowISO();
		const requestParams: ConnectionRequestParams = {
			from,
			to,
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
			protocolVersion: "1.0",
			timestamp: requestedAt,
		};

		const rpcRequest = buildConnectionRequest(requestParams);
		const requestId = String(rpcRequest.id);
		const xmtpAddress = peerAgent.xmtpEndpoint ?? peerAgent.agentAddress;
		const receipt = await transport.send(peerAgent.agentId, rpcRequest, {
			peerAddress: xmtpAddress,
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
				initialRequestedGrants: options.requestedGrants,
				initialOfferedGrants: options.offeredGrants,
			},
		};

		if (existing) {
			await trustStore.updateContact(existing.connectionId, nextContact);
		} else {
			await trustStore.addContact(nextContact);
		}

		const journal = new FileRequestJournal(dataDir);
		await journal.putOutbound({
			requestId,
			requestKey: `outbound:${rpcRequest.method}:${requestId}`,
			direction: "outbound",
			kind: "request",
			method: rpcRequest.method,
			peerAgentId: peerAgent.agentId,
			status: "acked",
		});

		if (options.notify) {
			await options.notify(
				`Connection request sent to ${peerAgent.registrationFile.name}; awaiting offline resolution`,
			);
		}

		return {
			success: true,
			connectionId,
			peerName: peerAgent.registrationFile.name,
			status: "pending",
			receiptStatus: receipt.status,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}
