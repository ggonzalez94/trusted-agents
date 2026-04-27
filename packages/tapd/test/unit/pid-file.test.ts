import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadTapdPidRecord,
	persistTapdPidRecordExclusive,
	pidFilePath,
} from "../../src/pid-file.js";

describe("pid-file", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-pid-test-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("derives the tapd pid file path under the data dir", () => {
		expect(pidFilePath("/tmp/tap-data")).toBe(join("/tmp/tap-data", ".tapd.pid"));
	});

	it("writes and reads a normalized tapd pid record", async () => {
		const path = pidFilePath(dataDir);

		await persistTapdPidRecordExclusive(path, {
			pid: 1234,
			binPath: "/tmp/tapd",
			ownerToken: "owner",
		});

		expect(await loadTapdPidRecord(path)).toEqual({
			pid: 1234,
			binPath: "/tmp/tapd",
			ownerToken: "owner",
		});
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("rejects clobbering an existing pid record", async () => {
		const path = pidFilePath(dataDir);

		await persistTapdPidRecordExclusive(path, { pid: 1234 });

		await expect(persistTapdPidRecordExclusive(path, { pid: 5678 })).rejects.toMatchObject({
			code: "EEXIST",
		});
		expect(await loadTapdPidRecord(path)).toEqual({ pid: 1234 });
	});

	it("normalizes non-string optional fields to undefined", async () => {
		const path = pidFilePath(dataDir);
		await writeFile(path, JSON.stringify({ pid: 1234, binPath: 42, ownerToken: null }), "utf-8");

		expect(await loadTapdPidRecord(path)).toEqual({ pid: 1234 });
	});

	it("rejects malformed pid records", async () => {
		const path = pidFilePath(dataDir);

		await writeFile(path, "", "utf-8");
		await expect(loadTapdPidRecord(path)).rejects.toThrow(`Invalid pid in ${path}`);

		await writeFile(path, "{", "utf-8");
		await expect(loadTapdPidRecord(path)).rejects.toThrow(`Invalid pidfile at ${path}:`);

		await writeFile(path, JSON.stringify({ pid: 0 }), "utf-8");
		await expect(loadTapdPidRecord(path)).rejects.toThrow(`Invalid pid in ${path}`);
	});
});
