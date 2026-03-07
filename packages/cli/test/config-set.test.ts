import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSetCommand } from "../src/commands/config-set.js";

describe("config set", () => {
	let tmpDir: string;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-config-set-test-"));
		stdoutWrites = [];
		stderrWrites = [];
		process.exitCode = undefined;
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

		await mkdir(tmpDir, { recursive: true });
		await writeFile(
			join(tmpDir, "config.yaml"),
			[
				"agent_id: 1",
				"chain: eip155:8453",
				"execution:",
				"  mode: eip7702",
				"  paymaster_provider: circle",
				"xmtp:",
				"  env: production",
				"",
			].join("\n"),
			"utf-8",
		);
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		process.exitCode = undefined;
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("normalizes camelCase execution keys to the yaml schema", async () => {
		await configSetCommand("execution.paymasterProvider", "candide", {
			json: true,
			dataDir: tmpDir,
		});

		const config = await readFile(join(tmpDir, "config.yaml"), "utf-8");
		expect(config).toContain("paymaster_provider: candide");
		expect(config).not.toContain("paymasterProvider:");
	});

	it("resolves chain aliases when updating the chain", async () => {
		await configSetCommand("chain", "base-sepolia", {
			json: true,
			dataDir: tmpDir,
		});

		const config = await readFile(join(tmpDir, "config.yaml"), "utf-8");
		expect(config).toContain("chain: eip155:84532");
	});
});
