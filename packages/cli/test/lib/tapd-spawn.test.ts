import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnTapdDetached, stopTapdDetached } from "../../src/lib/tapd-spawn.js";

/**
 * Stub tapd "binary" — just a tiny Node script that writes the port file the
 * CLI is waiting for, then idles until SIGTERM cleans it up. This lets us
 * exercise the spawn → wait → stop loop without a real tapd build.
 */
const STUB_TAPD = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const dataDir = process.env.TAP_DATA_DIR;
if (!dataDir) {
	process.stderr.write("missing TAP_DATA_DIR\\n");
	process.exit(1);
}

const port = 49999;
await writeFile(join(dataDir, ".tapd.port"), String(port), { encoding: "utf-8", mode: 0o600 });

let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	try {
		const { rm } = await import("node:fs/promises");
		await rm(join(dataDir, ".tapd.port"), { force: true });
	} catch {}
	process.exit(0);
};
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });

setInterval(() => {}, 60_000);
`;

describe("tapd-spawn", () => {
	let dataDir: string;
	let stubBin: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-spawn-"));
		stubBin = join(dataDir, "stub-tapd.mjs");
		await writeFile(stubBin, STUB_TAPD, { encoding: "utf-8", mode: 0o755 });
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	});

	it("spawns the binary, writes pidfile, and waits for the port file", async () => {
		const result = await spawnTapdDetached({
			dataDir,
			binPath: stubBin,
			startupTimeoutMs: 5_000,
		});

		expect(result.pid).toBeGreaterThan(0);
		expect(result.port).toBe(49999);
		expect(result.logPath).toBe(join(dataDir, ".tapd.log"));
		expect(result.pidPath).toBe(join(dataDir, ".tapd.pid"));

		// Cleanup so we don't leak a child process
		await stopTapdDetached(dataDir, 3_000);
	});

	it("stopTapdDetached SIGTERMs the child and removes the port file", async () => {
		const spawned = await spawnTapdDetached({
			dataDir,
			binPath: stubBin,
			startupTimeoutMs: 5_000,
		});

		const pid = await stopTapdDetached(dataDir, 3_000);
		expect(pid).toBe(spawned.pid);

		// Port file should be gone
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(dataDir, ".tapd.port"))).toBe(false);
	});

	it("spawnTapdDetached throws when bin path is missing", async () => {
		await expect(
			spawnTapdDetached({
				dataDir,
				binPath: join(dataDir, "does-not-exist.mjs"),
			}),
		).rejects.toThrow(/not found/);
	});

	it("stopTapdDetached throws when no pidfile exists", async () => {
		await expect(stopTapdDetached(dataDir)).rejects.toThrow(/pidfile/);
	});
});
