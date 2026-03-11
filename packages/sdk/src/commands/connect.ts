import {
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	TapMessagingService,
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
		const { inviteUrl, agentId, chain, dataDir, resolver, transport, privateKey } = options;
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

		const service = new TapMessagingService(
			{
				config: {
					agentId,
					chain,
					privateKey,
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
				`Connection request sent to ${peerAgent.registrationFile.name}; awaiting offline resolution`,
			);
		}

		return {
			success: true,
			connectionId: result.connectionId,
			peerName: result.peerName,
			status: result.status,
			receiptStatus: result.receipt?.status,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}
