import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultConfigPath,
	loadConfig,
	resolveConfigPath,
	resolveDataDir,
} from "../src/lib/config-loader.js";

describe("config-loader", () => {
	let tmpDir: string;
	let originalHome: string | undefined;
	const writeConfig = (lines: string[], dataDir = tmpDir) =>
		writeFile(defaultConfigPath(dataDir), [...lines, ""].join("\n"), "utf-8");

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
		unsetEnv("TAP_OWS_WALLET");
		unsetEnv("TAP_OWS_API_KEY");
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
			const configPath = join(tmpDir, "custom-config.yaml");
			await writeFile(configPath, ["agent_id: 1", "chain: eip155:8453", ""].join("\n"), "utf-8");

			const config = await loadConfig({ config: configPath }, { requireAgentId: false });

			expect(config.agentId).toBe(1);
			expect(config.chain).toBe("eip155:8453");
			expect(config.dataDir).toBe(tmpDir);
		});

		it("should prefer config.yaml inside dataDir when it exists", async () => {
			const dataDir = join(tmpDir, "data");
			await mkdir(dataDir, { recursive: true });
			await writeConfig(["agent_id: 1"], dataDir);

			const path = resolveConfigPath({}, dataDir);
			expect(path).toBe(defaultConfigPath(dataDir));
		});

		it("should return <dataDir>/config.yaml as default path", () => {
			const dataDir = join(tmpDir, "fresh-data-no-config");
			const path = resolveConfigPath({}, dataDir);
			expect(path).toBe(defaultConfigPath(dataDir));
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

		it("uses the config file directory when --config is set without a separate data dir", () => {
			const dir = resolveDataDir({ config: "/custom/agent/config.yaml" });
			expect(dir).toBe("/custom/agent");
		});
	});

	describe("loadConfig", () => {
		it.each([
			["Base", "base", "eip7702", "circle"],
			["Taiko mainnet", "taiko", "eip4337", "servo"],
		])("defaults %s to %s mode with %s paymaster", async (_, chain, mode, paymaster) => {
			await mkdir(tmpDir, { recursive: true });
			await writeConfig(["agent_id: 1", `chain: ${chain}`]);

			const config = await loadConfig({ dataDir: tmpDir });

			expect(config.execution?.mode).toBe(mode);
			expect(config.execution?.paymasterProvider).toBe(paymaster);
		});

		it("loads optional IPFS provider settings from config", async () => {
			await mkdir(tmpDir, { recursive: true });
			await writeConfig([
				"agent_id: 1",
				"chain: base",
				"ipfs:",
				"  provider: tack",
				"  tack_api_url: https://tack.example.test",
			]);

			const config = await loadConfig({ dataDir: tmpDir });
			expect(config.ipfs?.provider).toBe("tack");
			expect(config.ipfs?.tackApiUrl).toBe("https://tack.example.test");
		});

		it("defaults to Base mainnet when no config file exists", async () => {
			const dataDir = join(tmpDir, "mainnet-default");
			await mkdir(dataDir, { recursive: true });

			const config = await loadConfig({ dataDir }, { requireAgentId: false });
			expect(config.chain).toBe("eip155:8453");
		});

		it("preserves the saved chain when config.yaml already exists", async () => {
			const dataDir = join(tmpDir, "existing-config");
			await mkdir(dataDir, { recursive: true });
			await writeConfig(["agent_id: -1", "chain: eip155:167000"], dataDir);

			const config = await loadConfig({ dataDir }, { requireAgentId: false });
			expect(config.chain).toBe("eip155:167000");
		});

		it("overrides the selected chain RPC URL from CLI or env", async () => {
			const dataDir = join(tmpDir, "rpc-override");
			await mkdir(dataDir, { recursive: true });
			await writeConfig(["agent_id: 1", "chain: eip155:8453"], dataDir);

			process.env.TAP_RPC_URL = "https://example.test/base-override";
			const config = await loadConfig({ dataDir });

			expect(config.chains["eip155:8453"]?.rpcUrl).toBe("https://example.test/base-override");
		});

		it("rejects mismatched --config and --data-dir combinations", async () => {
			const dataDir = join(tmpDir, "agent-a");
			const otherDir = join(tmpDir, "agent-b");
			await mkdir(dataDir, { recursive: true });
			await mkdir(otherDir, { recursive: true });
			await writeConfig(["agent_id: 1", "chain: eip155:8453"], otherDir);

			await expect(
				loadConfig(
					{
						dataDir,
						config: defaultConfigPath(otherDir),
					},
					{ requireAgentId: false },
				),
			).rejects.toThrow(
				`Config path must match the TAP data dir config at ${defaultConfigPath(dataDir)}`,
			);
		});
	});
});

function unsetEnv(key: string): void {
	Reflect.deleteProperty(process.env, key);
}
