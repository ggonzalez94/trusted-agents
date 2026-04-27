import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenFilePath } from "../../src/auth-token.js";
import { portFilePath } from "../../src/port-file.js";
import { cleanupTapdRuntimeStateFiles, logFilePath } from "../../src/runtime-state-files.js";

describe("runtime-state-files", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-runtime-state-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("removes runtime-owned port and token files", async () => {
		await writeFile(portFilePath(dataDir), "49999", "utf-8");
		await writeFile(tokenFilePath(dataDir), "token", "utf-8");

		await cleanupTapdRuntimeStateFiles(dataDir);

		await expect(readFile(portFilePath(dataDir), "utf-8")).rejects.toThrow();
		await expect(readFile(tokenFilePath(dataDir), "utf-8")).rejects.toThrow();
	});

	it("derives the tapd log file path under the data dir", () => {
		expect(logFilePath("/tmp/tap-data")).toBe(join("/tmp/tap-data", ".tapd.log"));
	});

	it("allows missing runtime-owned state files", async () => {
		await expect(cleanupTapdRuntimeStateFiles(dataDir)).resolves.toBeUndefined();
	});
});
