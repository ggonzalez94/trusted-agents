import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	TransportOwnerLock,
	type TransportOwnershipError,
} from "../../../src/runtime/transport-owner-lock.js";

const tempDirs: string[] = [];

async function createDataDir() {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-lock-"));
	tempDirs.push(dataDir);
	return dataDir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
	);
});

describe("TransportOwnerLock", () => {
	it("writes and releases the ownership file", async () => {
		const dataDir = await createDataDir();
		const lock = new TransportOwnerLock(dataDir, "tap:test-owner");

		await lock.acquire();

		const owner = await lock.inspect();
		expect(owner).toEqual(
			expect.objectContaining({
				pid: process.pid,
				owner: "tap:test-owner",
			}),
		);

		const lockPath = join(dataDir, ".transport.lock");
		const raw = JSON.parse(await readFile(lockPath, "utf-8")) as { owner: string };
		expect(raw.owner).toBe("tap:test-owner");

		await lock.release();
		expect(await lock.inspect()).toBeNull();
	});

	it("rejects a second live owner with the current owner metadata", async () => {
		const dataDir = await createDataDir();
		const first = new TransportOwnerLock(dataDir, "tap:first");
		const second = new TransportOwnerLock(dataDir, "tap:second");

		await first.acquire();

		await expect(second.acquire()).rejects.toMatchObject<Partial<TransportOwnershipError>>({
			name: "TransportOwnershipError",
			currentOwner: expect.objectContaining({
				pid: process.pid,
				owner: "tap:first",
			}),
		});
	});

	it("reclaims stale lock files from dead owners", async () => {
		const dataDir = await createDataDir();
		const lockPath = join(dataDir, ".transport.lock");

		await writeFile(
			lockPath,
			JSON.stringify(
				{
					pid: 0,
					owner: "stale-owner",
					acquiredAt: "2026-01-01T00:00:00.000Z",
				},
				null,
				"\t",
			),
			"utf-8",
		);

		const lock = new TransportOwnerLock(dataDir, "tap:replacement");
		await lock.acquire();

		expect(await lock.inspect()).toEqual(
			expect.objectContaining({
				pid: process.pid,
				owner: "tap:replacement",
			}),
		);
	});

	it("reclaims stale lock from same logical owner (restart scenario)", async () => {
		const dataDir = await createDataDir();
		const lockPath = join(dataDir, ".transport.lock");
		const realDataDir = await import("node:fs/promises").then((m) => m.realpath(dataDir));

		// Simulate a stale lock left by a crashed process with the same owner label
		// but a live PID (simulates PID recycling by using current PID)
		await writeFile(
			lockPath,
			JSON.stringify(
				{
					pid: process.pid,
					owner: "openclaw:myagent",
					acquiredAt: "2026-01-01T00:00:00.000Z",
					dataDirRealpath: realDataDir,
				},
				null,
				"\t",
			),
			"utf-8",
		);

		// Same owner label should reclaim even though PID appears alive
		const lock = new TransportOwnerLock(dataDir, "openclaw:myagent");
		await lock.acquire();

		expect(await lock.inspect()).toEqual(
			expect.objectContaining({
				pid: process.pid,
				owner: "openclaw:myagent",
			}),
		);
	});

	it("reclaims copied lock files that point at a different data dir", async () => {
		const originalDir = await createDataDir();
		const copiedDir = await createDataDir();
		const original = new TransportOwnerLock(originalDir, "tap:original");

		await original.acquire();
		await writeFile(
			join(copiedDir, ".transport.lock"),
			await readFile(join(originalDir, ".transport.lock"), "utf-8"),
			"utf-8",
		);

		const replacement = new TransportOwnerLock(copiedDir, "tap:copied");
		await replacement.acquire();

		expect(await replacement.inspect()).toEqual(
			expect.objectContaining({
				pid: process.pid,
				owner: "tap:copied",
			}),
		);
	});
});
