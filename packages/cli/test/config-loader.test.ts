import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { resolveConfigPath, resolveDataDir } from "../src/lib/config-loader.js";

describe("config-loader", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-config-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
		// Clean up env vars
		delete process.env["TAP_DATA_DIR"];
		delete process.env["TAP_AGENT_ID"];
		delete process.env["TAP_CHAIN"];
		delete process.env["TAP_PRIVATE_KEY"];
	});

	describe("resolveConfigPath", () => {
		it("should use --config flag when provided", () => {
			const path = resolveConfigPath({ config: "/custom/config.yaml" });
			expect(path).toBe("/custom/config.yaml");
		});

		it("should use default path when no flag provided", () => {
			const path = resolveConfigPath({});
			expect(path).toContain("config.yaml");
		});
	});

	describe("resolveDataDir", () => {
		it("should use --data-dir flag when provided", () => {
			const dir = resolveDataDir({ dataDir: "/custom/data" });
			expect(dir).toBe("/custom/data");
		});

		it("should use TAP_DATA_DIR env when set", () => {
			process.env["TAP_DATA_DIR"] = "/env/data";
			const dir = resolveDataDir({});
			expect(dir).toBe("/env/data");
		});

		it("should use yaml data_dir when set", () => {
			const dir = resolveDataDir({}, { data_dir: tmpDir });
			expect(dir).toBe(tmpDir);
		});

		it("should prioritize CLI flag over env", () => {
			process.env["TAP_DATA_DIR"] = "/env/data";
			const dir = resolveDataDir({ dataDir: "/flag/data" });
			expect(dir).toBe("/flag/data");
		});
	});
});
