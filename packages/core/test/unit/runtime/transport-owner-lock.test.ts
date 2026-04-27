import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	TRANSPORT_OWNER_LOCK_FILE,
	TransportOwnerLock,
	type TransportOwnershipError,
	transportOwnerLockPath,
} from "../../../src/runtime/transport-owner-lock.js";
import { useTempDirs } from "../../helpers/temp-dir.js";

const { track: trackDir } = useTempDirs();

async function createDataDir() {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-lock-"));
	trackDir(dataDir);
	return dataDir;
}

describe("TransportOwnerLock", () => {
	it("pins the ownership lock file path", () => {
		expect(TRANSPORT_OWNER_LOCK_FILE).toBe(".transport.lock");
		expect(transportOwnerLockPath("/tmp/tap-data")).toBe(join("/tmp/tap-data", ".transport.lock"));
	});

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

		const lockPath = transportOwnerLockPath(dataDir);
		const raw = JSON.parse(await readFile(lockPath, "utf-8")) as {
			owner: string;
			instanceId?: string;
		};
		expect(raw.owner).toBe("tap:test-owner");
		expect(typeof raw.instanceId).toBe("string");

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
		const lockPath = transportOwnerLockPath(dataDir);

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

	it("rejects a second live owner even when the owner label matches", async () => {
		const dataDir = await createDataDir();
		const first = new TransportOwnerLock(dataDir, "openclaw:myagent");
		const second = new TransportOwnerLock(dataDir, "openclaw:myagent");

		await first.acquire();

		await expect(second.acquire()).rejects.toMatchObject<Partial<TransportOwnershipError>>({
			name: "TransportOwnershipError",
			currentOwner: expect.objectContaining({
				pid: process.pid,
				owner: "openclaw:myagent",
			}),
		});
	});

	it("reclaims copied lock files that point at a different data dir", async () => {
		const originalDir = await createDataDir();
		const copiedDir = await createDataDir();
		const original = new TransportOwnerLock(originalDir, "tap:original");

		await original.acquire();
		await writeFile(
			transportOwnerLockPath(copiedDir),
			await readFile(transportOwnerLockPath(originalDir), "utf-8"),
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

	it("does not delete a newer owner's lock during release", async () => {
		const dataDir = await createDataDir();
		const first = new TransportOwnerLock(dataDir, "tap:first");

		await first.acquire();
		await writeFile(
			transportOwnerLockPath(dataDir),
			JSON.stringify(
				{
					pid: 0,
					owner: "tap:second",
					acquiredAt: "2026-01-01T00:00:00.000Z",
					instanceId: "replacement-instance",
				},
				null,
				"\t",
			),
			"utf-8",
		);

		await first.release();

		expect(await first.inspect()).toEqual(
			expect.objectContaining({
				owner: "tap:second",
			}),
		);
	});
});
