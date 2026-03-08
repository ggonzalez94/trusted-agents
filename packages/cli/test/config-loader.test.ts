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
		unsetEnv("TAP_RPC_URL");
		unsetEnv("TAP_EXECUTION_MODE");
		unsetEnv("TAP_PAYMASTER_PROVIDER");
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

		it("should return <dataDir>/config.yaml as default path", () => {
			const dataDir = join(tmpDir, "fresh-data-no-config");
			const path = resolveConfigPath({}, dataDir);
			expect(path).toBe(join(dataDir, "config.yaml"));
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
		it("defaults Base networks to eip7702 with Circle", async () => {
			process.env.TAP_PRIVATE_KEY =
				"0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11";
			await mkdir(tmpDir, { recursive: true });
			await writeFile(
				join(tmpDir, "config.yaml"),
				"agent_id: 1\nchain: base-sepolia\nxmtp:\n  env: dev\n",
				"utf-8",
			);

			const config = await loadConfig({ dataDir: tmpDir });

			expect(config.execution?.mode).toBe("eip7702");
			expect(config.execution?.paymasterProvider).toBe("circle");
		});

		it("defaults Taiko networks to eoa with no paymaster provider", async () => {
			process.env.TAP_PRIVATE_KEY =
				"0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11";
			await mkdir(tmpDir, { recursive: true });
			await writeFile(
				join(tmpDir, "config.yaml"),
				"agent_id: 1\nchain: taiko\nxmtp:\n  env: production\n",
				"utf-8",
			);

			const config = await loadConfig({ dataDir: tmpDir });

			expect(config.execution?.mode).toBe("eoa");
			expect(config.execution?.paymasterProvider).toBeUndefined();
		});

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

		it("overrides the selected chain RPC URL from CLI or env", async () => {
			const dataDir = join(tmpDir, "rpc-override");
			await mkdir(join(dataDir, "identity"), { recursive: true });
			await writeFile(
				join(dataDir, "identity", "agent.key"),
				"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
				"utf-8",
			);
			await writeFile(
				join(dataDir, "config.yaml"),
				["agent_id: 1", "chain: eip155:8453", "xmtp:", "  env: production", ""].join("\n"),
				"utf-8",
			);

			process.env.TAP_RPC_URL = "https://example.test/base-override";
			const config = await loadConfig({ dataDir });

			expect(config.chains["eip155:8453"]?.rpcUrl).toBe("https://example.test/base-override");
		});
	});
});

function unsetEnv(key: string): void {
	Reflect.deleteProperty(process.env, key);
}
