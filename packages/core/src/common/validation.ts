import { isAddress } from "viem";

const CAIP2_REGEX = /^eip155:\d+$/;

export function isEthereumAddress(value: string): value is `0x${string}` {
	return isAddress(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function readNonEmptyString(value: unknown): string | undefined {
	return isNonEmptyString(value) ? value : undefined;
}

export function isCAIP2Chain(value: string): boolean {
	return CAIP2_REGEX.test(value);
}

export function caip2ToChainId(value: string): number | null {
	if (!isCAIP2Chain(value)) {
		return null;
	}
	const [, chainId] = value.split(":");
	const parsed = Number.parseInt(chainId ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
