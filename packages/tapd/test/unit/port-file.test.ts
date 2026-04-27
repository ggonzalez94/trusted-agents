import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadBoundPort,
	parseBoundPort,
	persistBoundPort,
	portFilePath,
} from "../../src/port-file.js";

describe("port-file", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-port-test-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("writes the bound port to <dataDir>/.tapd.port with mode 0600", async () => {
		await persistBoundPort(dataDir, 49999);

		const path = portFilePath(dataDir);
		expect(await readFile(path, "utf-8")).toBe("49999");

		const stats = await stat(path);
		expect(stats.mode & 0o777).toBe(0o600);
	});

	it("loads a persisted bound port", async () => {
		await persistBoundPort(dataDir, 49999);
		expect(await loadBoundPort(dataDir)).toBe(49999);
	});

	it("returns null when the port file is missing", async () => {
		expect(await loadBoundPort(dataDir)).toBeNull();
	});

	it("preserves legacy parseInt port parsing", async () => {
		expect(parseBoundPort("49999\n")).toBe(49999);
		expect(parseBoundPort("49999abc")).toBe(49999);
		expect(parseBoundPort("0")).toBeNull();
		expect(parseBoundPort("not-a-port")).toBeNull();
	});

	it("returns null for malformed persisted ports", async () => {
		await writeFile(portFilePath(dataDir), "not-a-port", "utf-8");
		expect(await loadBoundPort(dataDir)).toBeNull();
	});
});
