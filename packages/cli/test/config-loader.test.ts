import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfigPath, resolveDataDir } from "../src/lib/config-loader.js";

describe("config-loader", () => {
	let tmpDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-config-test-"));
		originalHome = process.env.HOME;
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
		process.env.HOME = originalHome;
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

		it("allows --config without a separately selected data dir", async () => {
			process.env.HOME = tmpDir;
			const defaultDataDir = join(tmpDir, ".trustedagents");
			const configPath = join(tmpDir, "custom-config.yaml");
			await mkdir(join(defaultDataDir, "identity"), { recursive: true });
			await writeFile(
				join(defaultDataDir, "identity", "agent.key"),
				"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
				"utf-8",
			);
			await writeFile(configPath, ["agent_id: 1", "chain: eip155:8453", ""].join("\n"), "utf-8");

			const config = await loadConfig({ config: configPath }, { requireAgentId: false });

			expect(config.agentId).toBe(1);
			expect(config.chain).toBe("eip155:8453");
			expect(config.dataDir).toBe(defaultDataDir);
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
			await writeFile(join(tmpDir, "config.yaml"), "agent_id: 1\nchain: base\n", "utf-8");

			const config = await loadConfig({ dataDir: tmpDir });

			expect(config.execution?.mode).toBe("eip7702");
			expect(config.execution?.paymasterProvider).toBe("circle");
		});

		it("defaults Taiko mainnet to eip4337 with Servo", async () => {
			process.env.TAP_PRIVATE_KEY =
				"0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11";
			await mkdir(tmpDir, { recursive: true });
			await writeFile(join(tmpDir, "config.yaml"), "agent_id: 1\nchain: taiko\n", "utf-8");

			const config = await loadConfig({ dataDir: tmpDir });

			expect(config.execution?.mode).toBe("eip4337");
			expect(config.execution?.paymasterProvider).toBe("servo");
		});

		it("loads optional IPFS provider settings from config", async () => {
			process.env.TAP_PRIVATE_KEY =
				"0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11";
			await mkdir(tmpDir, { recursive: true });
			await writeFile(
				join(tmpDir, "config.yaml"),
				[
					"agent_id: 1",
					"chain: base",
					"ipfs:",
					"  provider: tack",
					"  tack_api_url: https://tack.example.test",
					"",
				].join("\n"),
				"utf-8",
			);

			const config = await loadConfig({ dataDir: tmpDir });
			expect(config.ipfs?.provider).toBe("tack");
			expect(config.ipfs?.tackApiUrl).toBe("https://tack.example.test");
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
				["agent_id: -1", "chain: eip155:167000", ""].join("\n"),
				"utf-8",
			);

			const config = await loadConfig({ dataDir }, { requireAgentId: false });
			expect(config.chain).toBe("eip155:167000");
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
				["agent_id: 1", "chain: eip155:8453", ""].join("\n"),
				"utf-8",
			);

			process.env.TAP_RPC_URL = "https://example.test/base-override";
			const config = await loadConfig({ dataDir });

			expect(config.chains["eip155:8453"]?.rpcUrl).toBe("https://example.test/base-override");
		});

		it("rejects mismatched --config and --data-dir combinations", async () => {
			const dataDir = join(tmpDir, "agent-a");
			const otherDir = join(tmpDir, "agent-b");
			await mkdir(join(dataDir, "identity"), { recursive: true });
			await mkdir(otherDir, { recursive: true });
			await writeFile(
				join(dataDir, "identity", "agent.key"),
				"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
				"utf-8",
			);
			await writeFile(
				join(otherDir, "config.yaml"),
				["agent_id: 1", "chain: eip155:8453", ""].join("\n"),
				"utf-8",
			);

			await expect(
				loadConfig(
					{
						dataDir,
						config: join(otherDir, "config.yaml"),
					},
					{ requireAgentId: false },
				),
			).rejects.toThrow(
				`Config path must match the TAP data dir config at ${join(dataDir, "config.yaml")}`,
			);
		});
	});
});

function unsetEnv(key: string): void {
	Reflect.deleteProperty(process.env, key);
}
