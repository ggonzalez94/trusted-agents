import type { TrustedAgentsConfig } from "../../src/config/types.js";

export function buildRuntimeTestConfig(
	overrides: Partial<TrustedAgentsConfig> = {},
): TrustedAgentsConfig {
	return {
		agentId: 1,
		chain: "eip155:8453",
		ows: { wallet: "test", apiKey: "ows_key_test" },
		dataDir: "/tmp/tap",
		chains: {},
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60_000,
		resolveCacheMaxEntries: 128,
		...overrides,
	};
}
