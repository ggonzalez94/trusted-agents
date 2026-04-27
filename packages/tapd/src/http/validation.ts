import { HttpError } from "./errors.js";

export function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	return value as Record<string, unknown>;
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

export function isTapTransferAsset(value: unknown): value is "native" | "usdc" {
	return value === "native" || value === "usdc";
}

export function isZeroXPrefixedString(value: unknown): value is `0x${string}` {
	return typeof value === "string" && value.startsWith("0x");
}

export interface TapTransferFields {
	asset: "native" | "usdc";
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
}

export function hasTapTransferFields(
	value: Record<string, unknown>,
): value is Record<string, unknown> & TapTransferFields {
	if (!isTapTransferAsset(value.asset)) return false;
	if (!isNonEmptyString(value.amount)) return false;
	if (!isNonEmptyString(value.chain)) return false;
	if (!isZeroXPrefixedString(value.toAddress)) return false;
	return true;
}

// Route-level input validation throws HttpError(400, ...) so the server's
// top-level catch (see http/server.ts `handle`) maps missing route params
// and guard-rejected bodies to a 4xx response. Plain `Error` would fall
// through to the 500 branch, turning client input mistakes into apparent
// internal failures and breaking caller retry/handling logic.
export function requireParam(params: Record<string, string>, name: string): string {
	const value = params[name];
	if (!value) throw new HttpError(400, "missing_param", `missing ${name}`);
	return value;
}

export function requireBody<T>(
	body: unknown,
	guard: (v: unknown) => v is T,
	message: string,
): asserts body is T {
	if (!guard(body)) throw new HttpError(400, "invalid_body", message);
}

export interface OptionalReasonBody {
	reason?: string;
}

export function isOptionalReasonBody(value: unknown): value is OptionalReasonBody {
	if (value === undefined || value === null) return true;
	const v = asRecord(value);
	if (!v) return false;
	return isOptionalString(v.reason);
}
