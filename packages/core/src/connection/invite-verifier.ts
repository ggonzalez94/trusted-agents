import {
	encodeAbiParameters,
	keccak256,
	parseAbiParameters,
	recoverMessageAddress,
	toBytes,
} from "viem";
import { isAddressEqual } from "viem";
import { isExpired } from "../common/index.js";
import { ConnectionError } from "../common/index.js";
import type { InviteData } from "./types.js";

export function parseInviteUrl(url: string): InviteData {
	const parsed = new URL(url);
	const agentId = parsed.searchParams.get("agentId");
	const chain = parsed.searchParams.get("chain");
	const nonce = parsed.searchParams.get("nonce");
	const expires = parsed.searchParams.get("expires");
	const sig = parsed.searchParams.get("sig");

	if (!agentId || !chain || !nonce || !expires || !sig) {
		throw new ConnectionError("Invalid invite URL: missing required parameters");
	}

	const parsedExpires = Number.parseInt(expires, 10);
	if (Number.isNaN(parsedExpires)) {
		throw new ConnectionError("Invalid invite URL: expires is not a number");
	}

	if (!sig.startsWith("0x")) {
		throw new ConnectionError("Invalid invite URL: signature must start with 0x");
	}

	return {
		agentId: Number.parseInt(agentId, 10),
		chain: decodeURIComponent(chain),
		nonce,
		expires: parsedExpires,
		signature: sig as `0x${string}`,
	};
}

export async function verifyInvite(
	invite: InviteData,
	options?: { expectedSignerAddress?: `0x${string}` },
): Promise<{
	valid: boolean;
	signerAddress: `0x${string}`;
	error?: string;
}> {
	if (isExpired(invite.expires)) {
		return {
			valid: false,
			signerAddress: "0x0000000000000000000000000000000000000000",
			error: "Invite has expired",
		};
	}

	try {
		const message = keccak256(
			encodeAbiParameters(
				parseAbiParameters("uint256 agentId, string chain, string nonce, uint256 expires"),
				[BigInt(invite.agentId), invite.chain, invite.nonce, BigInt(invite.expires)],
			),
		);

		const signerAddress = await recoverMessageAddress({
			message: { raw: toBytes(message) },
			signature: invite.signature,
		});

		if (
			options?.expectedSignerAddress &&
			!isAddressEqual(signerAddress, options.expectedSignerAddress)
		) {
			return {
				valid: false,
				signerAddress,
				error: "Invite signer does not match expected agent identity",
			};
		}

		return { valid: true, signerAddress };
	} catch (err) {
		return {
			valid: false,
			signerAddress: "0x0000000000000000000000000000000000000000",
			error: err instanceof Error ? err.message : "Signature verification failed",
		};
	}
}
