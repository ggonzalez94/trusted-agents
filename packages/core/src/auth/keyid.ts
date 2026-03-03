import { isAddress } from "viem";
import { AuthenticationError } from "../common/index.js";

const KEYID_REGEX = /^erc8128:(\d+):(0x[0-9a-fA-F]{40})$/;

export interface ParsedKeyId {
	scheme: string;
	chainId: number;
	address: `0x${string}`;
}

export function parseKeyId(keyid: string): ParsedKeyId {
	const match = KEYID_REGEX.exec(keyid);
	if (!match) {
		throw new AuthenticationError(`Invalid keyid format: ${keyid}`);
	}

	const chainId = Number.parseInt(match[1]!, 10);
	const address = match[2]! as `0x${string}`;

	if (!isAddress(address)) {
		throw new AuthenticationError(`Invalid address in keyid: ${address}`);
	}

	return {
		scheme: "erc8128",
		chainId,
		address,
	};
}

export function formatKeyId(chainId: number, address: `0x${string}`): string {
	if (!isAddress(address)) {
		throw new AuthenticationError(`Invalid address: ${address}`);
	}
	if (!Number.isInteger(chainId) || chainId <= 0) {
		throw new AuthenticationError(`Invalid chainId: ${chainId}`);
	}
	return `erc8128:${chainId}:${address}`;
}
