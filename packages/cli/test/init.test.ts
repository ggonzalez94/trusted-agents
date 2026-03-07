import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { initCommand } from "../src/commands/init.js";

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

	it("should create config file, keyfile, and directory structure", async () => {
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
		expect(yaml.xmtp.env).toBe("production");

		// Keyfile created
		const keyfile = join(dataDir, "identity", "agent.key");
		expect(existsSync(keyfile)).toBe(true);
		const keyContent = await readFile(keyfile, "utf-8");
		expect(keyContent).toMatch(/^[0-9a-fA-F]{64}$/);

		// Directories created
		expect(existsSync(join(dataDir, "conversations"))).toBe(true);
		expect(existsSync(join(dataDir, "xmtp"))).toBe(true);

		// JSON output
		expect(stdoutWrites).toHaveLength(1);
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
	});

	it("should not overwrite existing keyfile", async () => {
		const dataDir = join(tmpDir, "data");

		// Run init twice
		await initCommand({ json: true, config: configPath, dataDir });
		const firstKey = await readFile(join(dataDir, "identity", "agent.key"), "utf-8");

		stdoutWrites = [];
		await initCommand({ json: true, config: join(tmpDir, "config2.yaml"), dataDir });
		const secondKey = await readFile(join(dataDir, "identity", "agent.key"), "utf-8");

		// Key should not be regenerated
		expect(firstKey).toBe(secondKey);
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
});
