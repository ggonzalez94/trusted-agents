export function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	return value as Record<string, unknown>;
}

export function requireParam(params: Record<string, string>, name: string): string {
	const value = params[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}
