import { FilePendingInviteStore, generateInvite, toISO } from "trusted-agents-core";

export interface InviteCommandOptions {
	privateKey: `0x${string}`;
	agentId: number;
	chain: string;
	dataDir?: string;
	expirySeconds?: number;
}

export interface InviteResult {
	url: string;
	expiresAt: string;
	nonce: string;
}

export async function executeInvite(options: InviteCommandOptions): Promise<InviteResult> {
	const { privateKey, agentId, chain, dataDir, expirySeconds } = options;

	const { url, invite } = await generateInvite({
		agentId,
		chain,
		privateKey,
		expirySeconds,
	});

	if (dataDir) {
		const store = new FilePendingInviteStore(dataDir);
		await store.create(invite.nonce, invite.expires);
	}

	return {
		url,
		expiresAt: toISO(invite.expires),
		nonce: invite.nonce,
	};
}
