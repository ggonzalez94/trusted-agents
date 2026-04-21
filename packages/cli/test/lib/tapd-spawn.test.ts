import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	// Finding F3.2: a stale port file from a prior (dead) daemon must not
	// be reported back as the new daemon's port.
	it("spawnTapdDetached unlinks a stale port file before spawn", async () => {
		// Pre-seed a bogus stale port file from a "previous run". If the
		// spawn path didn't clear it, waitForPortFile would return 11111
		// immediately before the real child has a chance to overwrite it.
		await writeFile(join(dataDir, ".tapd.port"), "11111", { encoding: "utf-8" });

		const result = await spawnTapdDetached({
			dataDir,
			binPath: stubBin,
			startupTimeoutMs: 5_000,
		});

		// The stub writes port 49999 — if we saw 11111, the stale file leaked.
		expect(result.port).toBe(49999);
		const onDisk = await readFile(join(dataDir, ".tapd.port"), "utf-8");
		expect(Number.parseInt(onDisk, 10)).toBe(49999);

		await stopTapdDetached(dataDir, 3_000);
	});

	it("spawnTapdDetached fails clearly when the child exits before writing the port file", async () => {
		const crasherBin = join(dataDir, "crasher-tapd.mjs");
		await writeFile(
			crasherBin,
			`#!/usr/bin/env node\nprocess.stderr.write("crashed on boot\\n");\nprocess.exit(17);\n`,
			{ encoding: "utf-8", mode: 0o755 },
		);

		await expect(
			spawnTapdDetached({
				dataDir,
				binPath: crasherBin,
				startupTimeoutMs: 5_000,
			}),
		).rejects.toThrow(/\.tapd\.log/);

		// Pidfile must be cleaned up so the next `tap daemon status` doesn't
		// report a running daemon that isn't there.
		expect(existsSync(join(dataDir, ".tapd.pid"))).toBe(false);
	});

	it("stopTapdDetached escalates to SIGKILL when SIGTERM is ignored", async () => {
		const stubbornBin = join(dataDir, "stubborn-tapd.mjs");
		await writeFile(
			stubbornBin,
			`#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const dataDir = process.env.TAP_DATA_DIR;
await writeFile(join(dataDir, ".tapd.port"), "49999", { encoding: "utf-8", mode: 0o600 });
// Install SIGTERM handler that ignores the signal entirely.
process.on("SIGTERM", () => {});
// Keep the event loop alive forever.
setInterval(() => {}, 60_000);
`,
			{ encoding: "utf-8", mode: 0o755 },
		);

		const spawned = await spawnTapdDetached({
			dataDir,
			binPath: stubbornBin,
			startupTimeoutMs: 5_000,
		});

		const stoppedPid = await stopTapdDetached(dataDir, 500);
		expect(stoppedPid).toBe(spawned.pid);

		// Both files must be removed only after the process is actually gone.
		expect(existsSync(join(dataDir, ".tapd.pid"))).toBe(false);
		expect(existsSync(join(dataDir, ".tapd.port"))).toBe(false);

		// And the process should now be dead.
		let alive = true;
		try {
			process.kill(spawned.pid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	});

	it("stopTapdDetached refuses to signal a pid that no longer matches tapd ownership", async () => {
		await writeFile(
			join(dataDir, ".tapd.pid"),
			JSON.stringify({
				pid: process.pid,
				ownerToken: "tapd-owner-token-that-does-not-match",
				binPath: stubBin,
			}),
			{ encoding: "utf-8", mode: 0o600 },
		);

		const killSpy = vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			signal?: NodeJS.Signals | 0,
		) => {
			if (pid !== process.pid) {
				throw new Error(`unexpected pid in test: ${pid}`);
			}
			if (signal === 0) return true as never;
			throw new Error(`stopTapdDetached should not send ${String(signal)} to a mismatched pid`);
		}) as typeof process.kill);

		await expect(stopTapdDetached(dataDir, 100)).rejects.toThrow(/not tapd|ownership|refus/i);
		expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
	});

	// Regression: two concurrent tap daemon start invocations must not both
	// succeed. The pidfile is created with O_CREAT|O_EXCL so exactly one
	// spawn wins; the loser must detect the race and kill its orphan child.
	it("spawnTapdDetached refuses to clobber an existing pidfile and kills its child", async () => {
		// Seed a pidfile as if a racing process just won the create. Use our
		// own pid so isProcessAlive() is true but ownership won't match —
		// what matters for this test is that the exclusive write fails.
		await writeFile(
			join(dataDir, ".tapd.pid"),
			JSON.stringify({ pid: process.pid, ownerToken: "racer", binPath: stubBin }),
			{ encoding: "utf-8", mode: 0o600 },
		);

		await expect(
			spawnTapdDetached({
				dataDir,
				binPath: stubBin,
				startupTimeoutMs: 2_000,
			}),
		).rejects.toThrow(/already.*progress|pidfile.*exists/i);

		// The pidfile we seeded must remain intact (we didn't clobber it).
		const raw = await readFile(join(dataDir, ".tapd.pid"), "utf-8");
		expect(JSON.parse(raw)).toMatchObject({ ownerToken: "racer" });
	});
});
