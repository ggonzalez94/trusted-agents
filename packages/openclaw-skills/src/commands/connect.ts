import {
	FileTrustStore,
	RequestSigner,
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
	IAgentResolver,
	JsonRpcResponse,
} from "trusted-agents-core";

export interface ConnectCommandOptions {
	inviteUrl: string;
	privateKey: `0x${string}`;
	agentId: number;
	chain: string;
	dataDir: string;
	resolver: IAgentResolver;
	sendRequest?: (endpoint: string, body: unknown) => Promise<unknown>;
	approveConnection?: (details: {
		peerName: string;
		peerAgentId: number;
		chain: string;
		capabilities: string[];
	}) => Promise<boolean>;
	notify?: (message: string) => Promise<void>;
}

export interface ConnectResult {
	success: boolean;
	connectionId?: string;
	peerName?: string;
	status?: "active" | "pending";
	error?: string;
}

export async function executeConnect(options: ConnectCommandOptions): Promise<ConnectResult> {
	try {
		const { inviteUrl, agentId, chain, dataDir, resolver } = options;
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
			});
			if (!approved) {
				return {
					success: false,
					error: "Connection request was rejected by local approval policy",
				};
			}
		}

		const connectionId = generateConnectionId();
		const from: AgentIdentifier = { agentId, chain };
		const to: AgentIdentifier = { agentId: invite.agentId, chain: invite.chain };
		const requestNonce = generateNonce();

		const requestParams: ConnectionRequestParams = {
			from,
			to,
			proposedScope: ["message/send"],
			nonce: requestNonce,
			protocolVersion: "1.0",
			timestamp: nowISO(),
		};

		const rpcRequest = buildConnectionRequest(requestParams);

		const response = options.sendRequest
			? await options.sendRequest(peerAgent.endpoint, rpcRequest)
			: await sendSignedJsonRpcRequest(peerAgent.endpoint, rpcRequest, options.privateKey, chainId);

		const acceptance = parseAcceptance(response);
		if (!acceptance.ok) {
			return {
				success: false,
				error: acceptance.error,
			};
		}

		const status: "active" | "pending" = acceptance.accepted ? "active" : "pending";

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
			status,
		};

		const trustStore = new FileTrustStore(dataDir);
		await trustStore.addContact(contact);

		if (options.notify) {
			await options.notify(
				status === "active"
					? `Connected to ${peerAgent.registrationFile.name}`
					: `Connection request sent to ${peerAgent.registrationFile.name}; awaiting acceptance`,
			);
		}

		return {
			success: true,
			connectionId,
			peerName: peerAgent.registrationFile.name,
			status,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

async function sendSignedJsonRpcRequest(
	endpoint: string,
	payload: unknown,
	privateKey: `0x${string}`,
	chainId: number,
): Promise<unknown> {
	const body = JSON.stringify(payload);
	const signer = new RequestSigner({
		privateKey,
		chainId,
	});

	const signedHeaders = await signer.sign({
		method: "POST",
		url: endpoint,
		headers: { "Content-Type": "application/json" },
		body,
	});

	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...signedHeaders,
		},
		body,
	});

	if (!response.ok) {
		throw new Error(`Connection request failed with HTTP ${response.status}`);
	}

	return response.json();
}

function parseAcceptance(response: unknown): {
	ok: boolean;
	accepted: boolean;
	error?: string;
} {
	if (!response || typeof response !== "object") {
		return { ok: false, accepted: false, error: "Invalid JSON-RPC response payload" };
	}

	const rpc = response as JsonRpcResponse & { result?: unknown };
	if (rpc.error) {
		return {
			ok: false,
			accepted: false,
			error:
				typeof rpc.error.message === "string"
					? `Peer rejected connection: ${rpc.error.message}`
					: "Peer rejected connection",
		};
	}

	if (rpc.result && typeof rpc.result === "object") {
		const result = rpc.result as Record<string, unknown>;
		if (result.accepted === true || result.status === "accepted") {
			return { ok: true, accepted: true };
		}
	}

	// Valid response without explicit acceptance semantics means request was received,
	// but the connection is still pending.
	return { ok: true, accepted: false };
}
