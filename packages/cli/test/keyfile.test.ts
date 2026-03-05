import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyfile, importKeyfile, keyfilePath, loadKeyfile } from "../src/lib/keyfile.js";

describe("keyfile", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "tap-keyfile-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should generate a keyfile with 64-char hex content", async () => {
		const result = await generateKeyfile(tmpDir);

		expect(result.path).toContain("agent.key");
		expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

		const content = await readFile(result.path, "utf-8");
		expect(content).toMatch(/^[0-9a-fA-F]{64}$/);
	});

	it("should create keyfile with restricted permissions (0o600)", async () => {
		const result = await generateKeyfile(tmpDir);
		const stats = await stat(result.path);
		// Check that only owner has read/write
		const mode = stats.mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("should load a previously generated keyfile", async () => {
		await generateKeyfile(tmpDir);
		const key = await loadKeyfile(tmpDir);

		expect(key).toMatch(/^0x[0-9a-fA-F]{64}$/);
	});

	it("should throw when keyfile does not exist", async () => {
		await expect(loadKeyfile(tmpDir)).rejects.toThrow();
	});

	it("should return correct keyfile path", () => {
		const path = keyfilePath("/some/dir");
		expect(path).toBe("/some/dir/identity/agent.key");
	});

	describe("importKeyfile", () => {
		it("should import a private key with 0x prefix", async () => {
			const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
			const result = await importKeyfile(tmpDir, key);

			expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

			const stored = await readFile(result.path, "utf-8");
			expect(stored).toBe(key.slice(2));
		});

		it("should import a private key without 0x prefix", async () => {
			const key = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
			const result = await importKeyfile(tmpDir, key);

			const stored = await readFile(result.path, "utf-8");
			expect(stored).toBe(key);
		});

		it("should reject invalid private key", async () => {
			await expect(importKeyfile(tmpDir, "not-a-key")).rejects.toThrow("Invalid private key");
		});

		it("should set restricted permissions on imported keyfile", async () => {
			const key = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
			const result = await importKeyfile(tmpDir, key);
			const stats = await stat(result.path);
			expect(stats.mode & 0o777).toBe(0o600);
		});
	});
});
