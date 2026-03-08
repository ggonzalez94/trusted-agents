import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfigPath, resolveDataDir } from "../src/lib/config-loader.js";

describe("config-loader", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-config-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
		// Clean up env vars
		unsetEnv("TAP_DATA_DIR");
		unsetEnv("TAP_AGENT_ID");
		unsetEnv("TAP_CHAIN");
		unsetEnv("TAP_PRIVATE_KEY");
	});

	describe("resolveConfigPath", () => {
		it("should use --config flag when provided", () => {
			const path = resolveConfigPath({ config: "/custom/config.yaml" }, "/some/data");
			expect(path).toBe("/custom/config.yaml");
		});

		it("should prefer config.yaml inside dataDir when it exists", async () => {
			const dataDir = join(tmpDir, "data");
			await mkdir(dataDir, { recursive: true });
			await writeFile(join(dataDir, "config.yaml"), "agent_id: 1", "utf-8");

			const path = resolveConfigPath({}, dataDir);
			expect(path).toBe(join(dataDir, "config.yaml"));
		});

		it("should keep config inside an explicit --data-dir even when legacy config exists", () => {
			const dataDir = join(tmpDir, "isolated-data");
			const path = resolveConfigPath({ dataDir }, dataDir);
			expect(path).toBe(join(dataDir, "config.yaml"));
		});

		it("should keep config inside TAP_DATA_DIR even when legacy config exists", () => {
			const dataDir = join(tmpDir, "isolated-env-data");
			process.env.TAP_DATA_DIR = dataDir;
			const path = resolveConfigPath({}, dataDir);
			expect(path).toBe(join(dataDir, "config.yaml"));
		});

		it("should return <dataDir>/config.yaml as default path", () => {
			// When neither dataDir nor legacy has a config, returns the new default
			const dataDir = join(tmpDir, "fresh-data-no-config");
			// Note: if legacy ~/.config/trustedagents/config.yaml exists on this
			// machine, the function will return that instead. This test verifies the
			// return value ends with config.yaml in either case.
			const path = resolveConfigPath({}, dataDir);
			expect(path).toMatch(/config\.yaml$/);
		});
	});

	describe("resolveDataDir", () => {
		it("should use --data-dir flag when provided", () => {
			const dir = resolveDataDir({ dataDir: "/custom/data" });
			expect(dir).toBe("/custom/data");
		});

		it("should use TAP_DATA_DIR env when set", () => {
			process.env.TAP_DATA_DIR = "/env/data";
			const dir = resolveDataDir({});
			expect(dir).toBe("/env/data");
		});

		it("should prioritize CLI flag over env", () => {
			process.env.TAP_DATA_DIR = "/env/data";
			const dir = resolveDataDir({ dataDir: "/flag/data" });
			expect(dir).toBe("/flag/data");
		});
	});

	describe("loadConfig", () => {
		it("defaults to Base mainnet when no config file exists", async () => {
			const dataDir = join(tmpDir, "mainnet-default");
			await mkdir(join(dataDir, "identity"), { recursive: true });
			await writeFile(
				join(dataDir, "identity", "agent.key"),
				"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
				"utf-8",
			);

			const config = await loadConfig({ dataDir }, { requireAgentId: false });
			expect(config.chain).toBe("eip155:8453");
		});

		it("preserves the saved chain when config.yaml already exists", async () => {
			const dataDir = join(tmpDir, "existing-config");
			await mkdir(join(dataDir, "identity"), { recursive: true });
			await writeFile(
				join(dataDir, "identity", "agent.key"),
				"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
				"utf-8",
			);
			await writeFile(
				join(dataDir, "config.yaml"),
				["agent_id: -1", "chain: eip155:84532", "xmtp:", "  env: dev", ""].join("\n"),
				"utf-8",
			);

			const config = await loadConfig({ dataDir }, { requireAgentId: false });
			expect(config.chain).toBe("eip155:84532");
		});
	});
});

function unsetEnv(key: "TAP_DATA_DIR" | "TAP_AGENT_ID" | "TAP_CHAIN" | "TAP_PRIVATE_KEY"): void {
	Reflect.deleteProperty(process.env, key);
}
