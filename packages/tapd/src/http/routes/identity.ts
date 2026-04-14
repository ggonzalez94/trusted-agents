import type { RouteHandler } from "../router.js";

export interface IdentityInfo {
	agentId: number;
	chain: string;
	address: string;
	displayName: string;
	dataDir: string;
}

export type IdentitySource = () => IdentityInfo;

export function createIdentityRoute(source: IdentitySource): RouteHandler<unknown, IdentityInfo> {
	return async () => source();
}
