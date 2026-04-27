import { describe, expect, it } from "vitest";
import {
	ALL_CHAINS,
	BASE_MAINNET,
	TAIKO_MAINNET,
	TRUSTED_AGENTS_CONFIG_FILE,
	defaultConfigPath,
	loadTrustedAgentConfigFromDataDir,
} from "../../../src/config/index.js";

describe("ALL_CHAINS", () => {
	it("includes Base and Taiko keyed by CAIP-2", () => {
		expect(ALL_CHAINS["eip155:8453"]).toBe(BASE_MAINNET);
		expect(ALL_CHAINS["eip155:167000"]).toBe(TAIKO_MAINNET);
	});

	it("Taiko config has registry address and RPC URL", () => {
		expect(TAIKO_MAINNET.chainId).toBe(167000);
		expect(TAIKO_MAINNET.caip2).toBe("eip155:167000");
		expect(TAIKO_MAINNET.rpcUrl).toMatch(/taiko/);
		expect(TAIKO_MAINNET.registryAddress).toMatch(/^0x/);
	});

	it("derives the default config path from the shared config filename", () => {
		expect(TRUSTED_AGENTS_CONFIG_FILE).toBe("config.yaml");
		expect(defaultConfigPath("/tmp/tap-data")).toBe("/tmp/tap-data/config.yaml");
	});

	it("is accepted by loadTrustedAgentConfigFromDataDir as extraChains", async () => {
		// Load with a non-existent dataDir; the loader tolerates a missing
		// config.yaml when requireAgentId is false, and the chains param merges
		// with DEFAULT_CONFIG.chains regardless of disk state.
		const config = await loadTrustedAgentConfigFromDataDir("/tmp/tapd-chains-test-nonexistent", {
			requireAgentId: false,
			agentId: 0,
			extraChains: ALL_CHAINS,
		});
		expect(config.chains["eip155:8453"]).toBeDefined();
		expect(config.chains["eip155:167000"]).toBeDefined();
		expect(config.chains["eip155:167000"]?.name).toBe("Taiko");
	});
});
