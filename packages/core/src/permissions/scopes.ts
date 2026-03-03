import { BOOTSTRAP_METHODS } from "../protocol/methods.js";

export const DEFAULT_SCOPES: Record<string, boolean | Record<string, unknown>> = {
	"general-chat": true,
	scheduling: true,
	research: { topics: ["any"] },
	purchases: { maxAmountUsd: 50 },
	"file-sharing": { maxSizeMb: 10 },
};

export function isValidScope(scope: string): boolean {
	return scope in DEFAULT_SCOPES;
}

export function isBootstrapMethod(method: string): boolean {
	return BOOTSTRAP_METHODS.has(method as Parameters<typeof BOOTSTRAP_METHODS.has>[0]);
}
