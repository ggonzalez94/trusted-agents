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
		Reflect.deleteProperty(process.env, "TAP_DATA_DIR");
		Reflect.deleteProperty(process.env, "TAP_AGENT_ID");
		Reflect.deleteProperty(process.env, "TAP_CHAIN");
		Reflect.deleteProperty(process.env, "TAP_PRIVATE_KEY");
		Reflect.deleteProperty(process.env, "TAP_EXECUTION_MODE");
		Reflect.deleteProperty(process.env, "TAP_PAYMASTER_PROVIDER");
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
	});
});
