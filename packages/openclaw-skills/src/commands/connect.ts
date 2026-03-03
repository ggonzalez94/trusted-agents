import {
	FileTrustStore,
	buildConnectionRequest,
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
	IAgentResolver,
} from "trusted-agents-core";

export interface ConnectCommandOptions {
	inviteUrl: string;
	privateKey: `0x${string}`;
	agentId: number;
	chain: string;
	dataDir: string;
	resolver: IAgentResolver;
	sendRequest?: (endpoint: string, body: unknown) => Promise<unknown>;
}

export interface ConnectResult {
	success: boolean;
	connectionId?: string;
	peerName?: string;
	error?: string;
}

export async function executeConnect(options: ConnectCommandOptions): Promise<ConnectResult> {
	const { inviteUrl, agentId, chain, dataDir, resolver } = options;

	const invite = parseInviteUrl(inviteUrl);

	const verification = await verifyInvite(invite);
	if (!verification.valid) {
		return {
			success: false,
			error: verification.error ?? "Invite verification failed",
		};
	}

	const peerAgent = await resolver.resolve(invite.agentId, invite.chain);

	const connectionId = generateConnectionId();
	const from: AgentIdentifier = { agentId, chain };
	const to: AgentIdentifier = { agentId: invite.agentId, chain: invite.chain };

	const requestParams: ConnectionRequestParams = {
		from,
		to,
		proposedScope: ["message/send"],
		nonce: generateNonce(),
		timestamp: nowISO(),
	};

	const rpcRequest = buildConnectionRequest(requestParams);

	if (options.sendRequest) {
		await options.sendRequest(peerAgent.endpoint, rpcRequest);
	}

	const contact: Contact = {
		connectionId,
		peerAgentId: peerAgent.agentId,
		peerChain: peerAgent.chain,
		peerOwnerAddress: peerAgent.ownerAddress,
		peerDisplayName: peerAgent.registrationFile.name,
		peerEndpoint: peerAgent.endpoint,
		peerAgentAddress: peerAgent.agentAddress,
		permissions: { "message/send": true },
		establishedAt: nowISO(),
		lastContactAt: nowISO(),
		status: "active",
	};

	const trustStore = new FileTrustStore(dataDir);
	await trustStore.addContact(contact);

	return {
		success: true,
		connectionId,
		peerName: peerAgent.registrationFile.name,
	};
}
