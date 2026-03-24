import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes } from "viem";
import { expiresIn } from "../common/index.js";
import type { TrustedAgentsAccount } from "../config/types.js";
import type { InviteData } from "./types.js";

const DEFAULT_EXPIRY_SECONDS = 3600;

export async function generateInvite(params: {
	agentId: number;
	chain: string;
	account: TrustedAgentsAccount;
	expirySeconds?: number;
}): Promise<{ url: string; invite: InviteData }> {
	const { agentId, chain, account, expirySeconds = DEFAULT_EXPIRY_SECONDS } = params;

	const expires = expiresIn(expirySeconds);

	const message = keccak256(
		encodeAbiParameters(parseAbiParameters("uint256 agentId, string chain, uint256 expires"), [
			BigInt(agentId),
			chain,
			BigInt(expires),
		]),
	);

	const signature = await account.signMessage({
		message: { raw: toBytes(message) },
	});

	const invite: InviteData = {
		agentId,
		chain,
		expires,
		signature,
	};

	const url = `https://trustedagents.link/connect?agentId=${agentId}&chain=${encodeURIComponent(chain)}&expires=${expires}&sig=${signature}`;

	return { url, invite };
}
