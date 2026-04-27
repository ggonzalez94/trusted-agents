import { isNonEmptyString, isObject } from "trusted-agents-core";
import { HttpError } from "./errors.js";

export { isNonEmptyString };

export function asRecord(value: unknown): Record<string, unknown> | null {
	if (!isObject(value)) return null;
	return value as Record<string, unknown>;
}

export function isNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

export function hasOptionalStringFields(
	value: Record<string, unknown>,
	fields: readonly string[],
): boolean {
	return fields.every((field) => isOptionalString(value[field]));
}

export function readOptionalStringField(value: unknown, field: string): string | undefined {
	const record = asRecord(value);
	const fieldValue = record?.[field];
	return typeof fieldValue === "string" ? fieldValue : undefined;
}

export function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

export function isOptionalBoolean(value: unknown): boolean {
	return value === undefined || isBoolean(value);
}

export function isOptionalNumber(value: unknown): boolean {
	return value === undefined || typeof value === "number";
}

export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function isPositiveFiniteNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value > 0;
}

export function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

export function isOptionalArray(value: unknown): boolean {
	return value === undefined || isArray(value);
}

export function isTapTransferAsset(value: unknown): value is "native" | "usdc" {
	return value === "native" || value === "usdc";
}

export function isZeroXPrefixedString(value: unknown): value is `0x${string}` {
	return typeof value === "string" && value.startsWith("0x");
}

export interface PeerField {
	peer: string;
}

export function hasPeerField(
	value: Record<string, unknown>,
): value is Record<string, unknown> & PeerField {
	return isNonEmptyString(value.peer);
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
