import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init.js";

describe("tap init --private-key", () => {
	let tmpDir: string;
	let configPath: string;
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;
	let stdoutWrites: string[];

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-init-import-"));
		configPath = join(tmpDir, "config.yaml");
		stdoutWrites = [];
		origStdoutWrite = process.stdout.write;
		origStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
	});

	afterEach(async () => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should import an existing private key", async () => {
		const dataDir = join(tmpDir, "data");
		const knownKey = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

		await initCommand({ json: true, config: configPath, dataDir }, { privateKey: knownKey });

		const keyfile = join(dataDir, "identity", "agent.key");
		expect(existsSync(keyfile)).toBe(true);
		const stored = await readFile(keyfile, "utf-8");
		expect(stored).toBe(knownKey);

		// Should output the correct address for this known key
		const output = JSON.parse(stdoutWrites[0]!);
		expect(output.ok).toBe(true);
		expect(output.data.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
	});

	it("should accept key with 0x prefix", async () => {
		const dataDir = join(tmpDir, "data");
		const knownKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

		await initCommand({ json: true, config: configPath, dataDir }, { privateKey: knownKey });

		const keyfile = join(dataDir, "identity", "agent.key");
		const stored = await readFile(keyfile, "utf-8");
		// Stored without 0x prefix
		expect(stored).toBe(knownKey.slice(2));
	});

	it("should overwrite existing keyfile when --private-key provided", async () => {
		const dataDir = join(tmpDir, "data");

		// First init generates a random key
		await initCommand({ json: true, config: configPath, dataDir });
		const firstKey = await readFile(join(dataDir, "identity", "agent.key"), "utf-8");

		// Second init with explicit key should overwrite
		stdoutWrites = [];
		const importKey = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		await initCommand(
			{ json: true, config: join(tmpDir, "config2.yaml"), dataDir },
			{ privateKey: importKey },
		);

		const secondKey = await readFile(join(dataDir, "identity", "agent.key"), "utf-8");
		expect(secondKey).toBe(importKey);
		expect(secondKey).not.toBe(firstKey);
	});
});
