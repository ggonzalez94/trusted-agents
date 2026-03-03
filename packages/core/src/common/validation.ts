import { isAddress } from "viem";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAIP2_REGEX = /^eip155:\d+$/;

export function isEthereumAddress(value: string): value is `0x${string}` {
	return isAddress(value);
}

export function isValidUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

export function isValidUUID(value: string): boolean {
	return UUID_REGEX.test(value);
}

export function isCAIP2Chain(value: string): boolean {
	return CAIP2_REGEX.test(value);
}

export function assertEthereumAddress(value: string): asserts value is `0x${string}` {
	if (!isEthereumAddress(value)) {
		throw new Error(`Invalid Ethereum address: ${value}`);
	}
}
