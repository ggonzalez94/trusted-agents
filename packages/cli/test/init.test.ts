import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { initCommand } from "../src/commands/init.js";
import { runCli } from "./helpers/run-cli.js";

describe("tap init", () => {
	let tmpDir: string;
	let configPath: string;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-init-test-"));
		configPath = join(tmpDir, "config.yaml");
		stdoutWrites = [];
		stderrWrites = [];
		origStdoutWrite = process.stdout.write;
		origStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => {
			stderrWrites.push(chunk);
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should create config file and directory structure", async () => {
		const dataDir = join(tmpDir, "data");

		await initCommand({
			json: true,
			config: configPath,
			dataDir,
		});

		// Config file created
		expect(existsSync(configPath)).toBe(true);
		const configContent = await readFile(configPath, "utf-8");
		const yaml = YAML.parse(configContent);
		expect(yaml.agent_id).toBe(-1);
		expect(yaml.chain).toBe("eip155:8453");

		// Directories created
		expect(existsSync(join(dataDir, "conversations"))).toBe(true);
		expect(existsSync(join(dataDir, "xmtp"))).toBe(true);

		// JSON output
		expect(stdoutWrites).toHaveLength(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.chain).toBe("eip155:8453");
	});

	it("should not overwrite existing config", async () => {
		const dataDir = join(tmpDir, "data");

		// Run init twice
		await initCommand({ json: true, config: configPath, dataDir });
		const firstConfig = await readFile(configPath, "utf-8");

		stdoutWrites = [];
		await initCommand({ json: true, config: configPath, dataDir });
		const secondConfig = await readFile(configPath, "utf-8");

		// Config should not be regenerated
		expect(firstConfig).toBe(secondConfig);
	});

	it("should create config inside an explicit data dir without reusing legacy config", async () => {
		const dataDir = join(tmpDir, "isolated-data");

		await initCommand({
			json: true,
			dataDir,
		});

		expect(existsSync(join(dataDir, "config.yaml"))).toBe(true);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.data.config).toBe(join(dataDir, "config.yaml"));
	});

	it("reuses the saved chain in output when init is rerun", async () => {
		const dataDir = join(tmpDir, "existing-chain");

		await initCommand(
			{
				json: true,
				dataDir,
			},
			{ chain: "taiko" },
		);

		stdoutWrites = [];
		await initCommand({
			json: true,
			dataDir,
		});

		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.data.chain).toBe("eip155:167000");
		expect(output.data.chain_name).toBe("Taiko");
	});

	it("respects the init --chain flag through the CLI entrypoint", async () => {
		const dataDir = join(tmpDir, "cli-entrypoint");
		const result = await runCli(["--json", "--data-dir", dataDir, "init", "--chain", "base"]);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.data.chain).toBe("eip155:8453");
		expect(output.data.chain_name).toBe("Base");
	});
});
