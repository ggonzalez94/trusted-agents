import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fsErrorCode } from "trusted-agents-core";
import { toErrorMessage } from "./errors.js";

/**
 * Resolves the absolute path to the tapd `bin.js` script. Uses the workspace
 * package layout (`trusted-agents-tapd/dist/bin.js`) so a `bun install`-linked
 * dependency works in dev and the bundled package works in production.
 */
export function resolveTapdBinPath(): string {
	const require = createRequire(import.meta.url);
	const pkgPath = require.resolve("trusted-agents-tapd/package.json");
	const pkgDir = pkgPath.replace(/\/package\.json$/, "");
	return join(pkgDir, "dist", "bin.js");
}

const PORT_FILE = ".tapd.port";
const PID_FILE = ".tapd.pid";
const LOG_FILE = ".tapd.log";

export interface TapdSpawnOptions {
	dataDir: string;
	/** Override the path to tapd's bin.js (used by tests). */
	binPath?: string;
	/** Wait at most this many ms for the port file to appear. */
	startupTimeoutMs?: number;
	/** Extra env passed to the daemon (merged on top of process.env). */
	env?: Record<string, string>;
}

export interface TapdSpawnResult {
	pid: number;
	port: number;
	logPath: string;
	pidPath: string;
}

/**
 * Spawn tapd as a detached background process. Writes a pidfile to
 * `<dataDir>/.tapd.pid`, redirects stdio to `<dataDir>/.tapd.log`, and waits
 * for the port file to appear before resolving.
 *
 * Also guards against two split-brain failure modes:
 * 1. A stale `.tapd.port` file from a prior (now-dead) daemon is unlinked
 *    before spawn so `waitForPortFile` cannot match it and report success
 *    for a process that hasn't actually bound a port yet.
 * 2. If the child crashes before writing the port file, we raise a clear
 *    error (including the log path) rather than waiting for the timeout.
 */
export async function spawnTapdDetached(options: TapdSpawnOptions): Promise<TapdSpawnResult> {
	const binPath = options.binPath ?? resolveTapdBinPath();
	if (!existsSync(binPath)) {
		throw new Error(
			`tapd binary not found at ${binPath}. Run \`bun run --cwd packages/tapd build\` first.`,
		);
	}

	const logPath = join(options.dataDir, LOG_FILE);
	const pidPath = join(options.dataDir, PID_FILE);
	const portPath = join(options.dataDir, PORT_FILE);

	// Unlink any stale port file from a previous run. Without this, the port
	// wait below can return a stale port from a dead daemon and the caller
	// never notices the new child crashed (finding F3.2).
	await rm(portPath, { force: true }).catch(() => {});

	// Truncate the log on each spawn so users see the current run cleanly.
	const logHandle = await open(logPath, "w", 0o600);
	const child: ChildProcess = spawn(process.execPath, [binPath], {
		cwd: options.dataDir,
		detached: true,
		stdio: ["ignore", logHandle.fd, logHandle.fd],
		env: {
			...process.env,
			...(options.env ?? {}),
			TAP_DATA_DIR: options.dataDir,
		},
	});
	child.unref();
	await logHandle.close();

	if (!child.pid) {
		throw new Error("Failed to spawn tapd: no pid assigned");
	}

	const childPid = child.pid;
	const { writeFile } = await import("node:fs/promises");
	await writeFile(pidPath, String(childPid), { encoding: "utf-8", mode: 0o600 });

	const timeoutMs = options.startupTimeoutMs ?? 5_000;
	try {
		const port = await waitForPortFileAndLiveness(portPath, childPid, timeoutMs);
		return { pid: childPid, port, logPath, pidPath };
	} catch (error) {
		// Remove the pidfile we just wrote — the child is dead or never bound,
		// so leaving the pidfile around would make the status/stop commands
		// think a real daemon is running.
		await rm(pidPath, { force: true }).catch(() => {});
		if (error instanceof TapdStartupError) {
			throw new Error(`${error.message} See ${logPath} for details.`);
		}
		throw error;
	}
}

/**
 * Stops a running tapd by reading the pidfile, sending SIGTERM, and waiting
 * for the child process to actually exit. Removes both files when shutdown
 * completes. If SIGTERM times out, escalates to SIGKILL. If SIGKILL also
 * fails to terminate the process, leaves the pidfile in place (as evidence)
 * and raises an error — so `tap daemon status` doesn't claim success against
 * a zombie process (finding F3.2).
 */
export async function stopTapdDetached(dataDir: string, timeoutMs = 5_000): Promise<number> {
	const pidPath = join(dataDir, PID_FILE);
	const portPath = join(dataDir, PORT_FILE);

	let pid: number;
	try {
		pid = Number.parseInt((await readFile(pidPath, "utf-8")).trim(), 10);
	} catch {
		throw new Error(`No tapd pidfile at ${pidPath}. Is tapd running?`);
	}
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(`Invalid pid in ${pidPath}`);
	}

	async function cleanupAndReturn(): Promise<number> {
		await rm(pidPath, { force: true }).catch(() => {});
		await rm(portPath, { force: true }).catch(() => {});
		return pid;
	}

	// Fast path — process already gone. Clean up and return.
	if (!isProcessAlive(pid)) return await cleanupAndReturn();

	try {
		process.kill(pid, "SIGTERM");
	} catch (err) {
		if (fsErrorCode(err) === "ESRCH") return await cleanupAndReturn();
		throw err;
	}

	if (await waitForExit(pid, portPath, timeoutMs)) return await cleanupAndReturn();

	// SIGTERM was ignored — escalate. Give the process a short window to
	// finish the KILL before giving up.
	try {
		process.kill(pid, "SIGKILL");
	} catch (err) {
		if (fsErrorCode(err) === "ESRCH") return await cleanupAndReturn();
		// SIGKILL delivery failed for some other reason (EPERM, etc). Leave
		// the pidfile in place as evidence and surface the error.
		throw new Error(
			`tapd (pid ${pid}) could not be killed: ${toErrorMessage(err)}. Pidfile left in place.`,
		);
	}

	if (await waitForExit(pid, portPath, 1_000)) return await cleanupAndReturn();

	// SIGKILL was delivered but the process is STILL alive (e.g. uninterruptible
	// wait). Leave the pidfile as evidence so status reports it.
	throw new Error(
		`tapd (pid ${pid}) did not exit after SIGKILL. Pidfile left in place for diagnostics.`,
	);
}

/**
 * Returns true when `pid` is alive (or we cannot tell — in which case we err
 * on the "alive" side to avoid stomping on a running daemon).
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if (fsErrorCode(err) === "ESRCH") return false;
		// EPERM means the process exists but we can't signal it — still alive.
		return true;
	}
}

async function waitForExit(pid: number, portPath: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid) && !existsSync(portPath)) return true;
		if (!isProcessAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return !isProcessAlive(pid);
}

/**
 * Thin wrapper type so `spawnTapdDetached` can distinguish its own startup
 * errors (child crashed, port never bound) from unexpected exceptions.
 */
class TapdStartupError extends Error {}

async function waitForPortFileAndLiveness(
	portPath: string,
	childPid: number,
	timeoutMs: number,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const raw = await readFile(portPath, "utf-8");
			const port = Number.parseInt(raw.trim(), 10);
			if (Number.isInteger(port) && port > 0) return port;
		} catch {
			// not yet
		}
		if (!isProcessAlive(childPid)) {
			throw new TapdStartupError(`tapd (pid ${childPid}) exited before writing the port file.`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	// Timed out. If the child is still alive it's just slow; if it's dead,
	// surface the crash explicitly.
	if (!isProcessAlive(childPid)) {
		throw new TapdStartupError(`tapd (pid ${childPid}) exited before writing the port file.`);
	}
	throw new TapdStartupError(`Timed out waiting for tapd to bind a port (${portPath}).`);
}
