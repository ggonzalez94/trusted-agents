import { generateInvite, toISO } from "trusted-agents-core";

export interface InviteCommandOptions {
	privateKey: `0x${string}`;
	agentId: number;
	chain: string;
	expirySeconds?: number;
}

export interface InviteResult {
	url: string;
	expiresAt: string;
	nonce: string;
}

export async function executeInvite(options: InviteCommandOptions): Promise<InviteResult> {
	const { privateKey, agentId, chain, expirySeconds } = options;

	const { url, invite } = await generateInvite({
		agentId,
		chain,
		privateKey,
		expirySeconds,
	});

	return {
		url,
		expiresAt: toISO(invite.expires),
		nonce: invite.nonce,
	};
}
