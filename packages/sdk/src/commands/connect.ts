import {
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	TapMessagingService,
	ValidationError,
	caip2ToChainId,
	isSelfInvite,
	parseInviteUrl,
	verifyInvite,
} from "trusted-agents-core";
import type { IAgentResolver, TransportProvider, TransportReceipt } from "trusted-agents-core";

export interface ConnectCommandOptions {
	inviteUrl: string;
	privateKey: `0x${string}`;
	agentId: number;
	chain: string;
	dataDir: string;
	resolver: IAgentResolver;
	transport: TransportProvider;
	notify?: (message: string) => Promise<void>;
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
		const result = await service.connect({ inviteUrl });

		await options.notify?.(
			result.status === "active"
				? `Connected to ${result.peerName}`
				: `Connection request sent to ${result.peerName}; awaiting their result`,
		);

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
