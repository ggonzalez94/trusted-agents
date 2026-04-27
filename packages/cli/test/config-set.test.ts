import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { configSetCommand } from "../src/commands/config-set.js";
import { defaultConfigPath } from "../src/lib/config-loader.js";
import { useCapturedOutput } from "./helpers/capture-output.js";

describe("config set", () => {
	let tmpDir: string;
	const { stdout: stdoutWrites } = useCapturedOutput();
	const configPath = () => defaultConfigPath(tmpDir);
	const readConfig = () => readFile(configPath(), "utf-8");
	const readConfigYaml = async <T>() => YAML.parse(await readConfig()) as T;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-config-set-test-"));
		process.exitCode = undefined;

		await mkdir(tmpDir, { recursive: true });
		await writeFile(
			configPath(),
			[
				"agent_id: 1",
				"chain: eip155:8453",
				"execution:",
				"  mode: eip7702",
				"  paymaster_provider: circle",
				"",
			].join("\n"),
			"utf-8",
		);
	});

	afterEach(async () => {
		process.exitCode = undefined;
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("normalizes camelCase execution keys to the yaml schema", async () => {
		await configSetCommand("execution.paymasterProvider", "candide", {
			json: true,
			dataDir: tmpDir,
		});

		const config = await readConfig();
		expect(config).toContain("paymaster_provider: candide");
		expect(config).not.toContain("paymasterProvider:");
	});

	it("resolves chain aliases when updating the chain", async () => {
		await configSetCommand("chain", "taiko", {
			json: true,
			dataDir: tmpDir,
		});

		const config = await readConfig();
		expect(config).toContain("chain: eip155:167000");
	});

	it("only coerces known numeric config keys", async () => {
		await configSetCommand("resolve_cache_ttl_ms", "60000", {
			json: true,
			dataDir: tmpDir,
		});
		await configSetCommand("ipfs.provider", "1234", {
			json: true,
			dataDir: tmpDir,
		});

		const config = await readConfigYaml<{
			resolve_cache_ttl_ms: unknown;
			ipfs?: { provider?: unknown };
		}>();
		expect(config.resolve_cache_ttl_ms).toBe(60000);
		expect(config.ipfs?.provider).toBe("1234");
	});

	it("normalizes camelCase IPFS keys to the yaml schema", async () => {
		await configSetCommand("ipfs.tackApiUrl", "https://tack.example.test", {
			json: true,
			dataDir: tmpDir,
		});

		const config = await readConfig();
		expect(config).toContain("tack_api_url: https://tack.example.test");
		expect(config).not.toContain("tackApiUrl:");
	});

	it("rejects split-brain config and data-dir overrides", async () => {
		const otherDir = join(tmpDir, "other-agent");
		const otherConfigPath = defaultConfigPath(otherDir);
		await mkdir(otherDir, { recursive: true });
		await writeFile(otherConfigPath, "agent_id: 9\nchain: eip155:8453\n", "utf-8");

		await configSetCommand("chain", "base", {
			json: true,
			dataDir: tmpDir,
			config: otherConfigPath,
		});

		expect(process.exitCode).toBe(1);
		expect(stdoutWrites.join("")).toContain("Config path must match the TAP data dir config");
	});
});
