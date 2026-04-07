import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock } from "../src/hermes/file-lock.js";

describe("Hermes file lock", () => {
	const createdDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			createdDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
		);
	});

	it(
		"recovers from a stale corrupted lock file",
		async () => {
			const stateDir = await mkdtemp(join(tmpdir(), "tap-hermes-lock-"));
			createdDirs.push(stateDir);

			const lockPath = join(stateDir, "notifications.lock");
			await writeFile(lockPath, "{", "utf-8");
			const staleTime = new Date(Date.now() - 45_000);
			await utimes(lockPath, staleTime, staleTime);

			let ran = false;
			await withFileLock(lockPath, async () => {
				ran = true;
			});

			expect(ran).toBe(true);
			await expect(readFile(lockPath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		},
		10_000,
	);
});
