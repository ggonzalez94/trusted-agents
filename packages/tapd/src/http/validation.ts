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

export function requireParam(params: Record<string, string>, name: string): string {
	const value = params[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

export function requireBody<T>(
	body: unknown,
	guard: (v: unknown) => v is T,
	message: string,
): asserts body is T {
	if (!guard(body)) throw new Error(message);
}
