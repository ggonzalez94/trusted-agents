export function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	return value as Record<string, unknown>;
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
