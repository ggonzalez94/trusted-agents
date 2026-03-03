import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes } from "viem";
import { signMessage } from "viem/accounts";
import { expiresIn, generateNonce } from "../common/index.js";
import type { InviteData } from "./types.js";

const DEFAULT_EXPIRY_SECONDS = 3600;

export async function generateInvite(params: {
	agentId: number;
	chain: string;
	privateKey: `0x${string}`;
	expirySeconds?: number;
}): Promise<{ url: string; invite: InviteData }> {
	const { agentId, chain, privateKey, expirySeconds = DEFAULT_EXPIRY_SECONDS } = params;

	const nonce = generateNonce();
	const expires = expiresIn(expirySeconds);

	const message = keccak256(
		encodeAbiParameters(
			parseAbiParameters("uint256 agentId, string chain, string nonce, uint256 expires"),
			[BigInt(agentId), chain, nonce, BigInt(expires)],
		),
	);

	const signature = await signMessage({
		message: { raw: toBytes(message) },
		privateKey,
	});

	const invite: InviteData = {
		agentId,
		chain,
		nonce,
		expires,
		signature,
	};

	const url = `https://trustedagents.link/connect?agentId=${agentId}&chain=${encodeURIComponent(chain)}&nonce=${nonce}&expires=${expires}&sig=${signature}`;

	return { url, invite };
}
