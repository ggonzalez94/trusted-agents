import type { ChainConfig, ExecutionPreview, TrustedAgentsConfig } from "trusted-agents-core";

export const TEST_BASE_CHAIN: ChainConfig = {
	name: "Base",
	caip2: "eip155:8453",
	chainId: 8453,
	rpcUrl: "https://example.test/base",
	registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
};

export const TEST_TAIKO_CHAIN: ChainConfig = {
	name: "Taiko",
	caip2: "eip155:167000",
	chainId: 167000,
	rpcUrl: "https://example.test/taiko",
	registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
};

export const UNREGISTERED_AGENT_CONFIG_YAML = [
	"agent_id: -1",
	"chain: eip155:8453",
	"ows:",
	"  wallet: demo-wallet",
	"  api_key: demo-key",
].join("\n");

export function buildMockExecutionPreview(
	address: `0x${string}`,
	overrides?: Partial<ExecutionPreview>,
): ExecutionPreview {
	return {
		requestedMode: "eip7702",
		mode: "eip7702",
		messagingAddress: address,
		executionAddress: address,
		fundingAddress: address,
		paymasterProvider: "circle",
		warnings: [],
		...overrides,
	};
}

export function buildTestConfig(overrides?: Partial<TrustedAgentsConfig>): TrustedAgentsConfig {
	return {
		agentId: -1,
		chain: "eip155:8453",
		ows: { wallet: "test-wallet", apiKey: "test-api-key" },
		dataDir: "/tmp/tap",
		chains: { "eip155:8453": TEST_BASE_CHAIN },
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60000,
		resolveCacheMaxEntries: 100,
		xmtpDbEncryptionKey: undefined,
		execution: { mode: "eip7702", paymasterProvider: "circle" },
		...overrides,
	};
}
