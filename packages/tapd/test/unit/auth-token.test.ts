import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAuthToken, loadAuthToken, persistAuthToken } from "../../src/auth-token.js";

describe("auth-token", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-auth-test-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	describe("generateAuthToken", () => {
		it("returns a 32-character hex string", () => {
			const token = generateAuthToken();
			expect(token).toMatch(/^[0-9a-f]{32}$/);
		});

		it("returns a different token on each call", () => {
			const a = generateAuthToken();
			const b = generateAuthToken();
			expect(a).not.toEqual(b);
		});
	});

	describe("persistAuthToken", () => {
		it("writes the token to <dataDir>/.tapd-token with mode 0600", async () => {
			const token = "abcdef0123456789abcdef0123456789";
			await persistAuthToken(dataDir, token);

			const tokenPath = join(dataDir, ".tapd-token");
			const contents = await readFile(tokenPath, "utf-8");
			expect(contents).toBe(token);

			const stats = await stat(tokenPath);
			expect(stats.mode & 0o777).toBe(0o600);
		});

		it("overwrites an existing token file", async () => {
			await persistAuthToken(dataDir, "old-token-padding-padding-padding");
			await persistAuthToken(dataDir, "new-token-padding-padding-padding");

			const contents = await readFile(join(dataDir, ".tapd-token"), "utf-8");
			expect(contents).toBe("new-token-padding-padding-padding");
		});
	});

	describe("loadAuthToken", () => {
		it("returns the persisted token", async () => {
			const token = "loaded-token-padding-padding-pad";
			await persistAuthToken(dataDir, token);
			expect(await loadAuthToken(dataDir)).toBe(token);
		});

		it("returns null when no token file exists", async () => {
			expect(await loadAuthToken(dataDir)).toBeNull();
		});
	});
});
