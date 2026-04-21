import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fsErrorCode } from "trusted-agents-core";
import { TAPD_PID_FILE, TAPD_PORT_FILE } from "trusted-agents-tapd";
import { toErrorMessage } from "./errors.js";

const execFileAsync = promisify(execFile);
const TAPD_OWNER_ARG_PREFIX = "--tapd-owner-token=";

/**
 * Resolves the absolute path to the tapd `bin.js` script. Uses the workspace
 * package layout (`trusted-agents-tapd/dist/bin.js`) so a `bun install`-linked
 * dependency works in dev and the bundled package works in production.
 *
 * Supported platforms are Linux and macOS; Windows is out of scope for tap.
 * `dirname` from `node:path` picks the right separator handling for the
 * host platform, so there is no need for an explicit `/`-only regex.
 */
export function resolveTapdBinPath(): string {
	const require = createRequire(import.meta.url);
	const pkgPath = require.resolve("trusted-agents-tapd/package.json");
	const pkgDir = dirname(pkgPath);
	return join(pkgDir, "dist", "bin.js");
}

const LOG_FILE = ".tapd.log";

interface TapdPidRecord {
	pid: number;
	binPath?: string;
	ownerToken?: string;
}

export interface TapdProcessInspection {
	status: "missing" | "running" | "dead" | "mismatch" | "unknown";
	pid?: number;
	message?: string;
}

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

async function readTapdPidRecord(pidPath: string): Promise<TapdPidRecord> {
	const raw = (await readFile(pidPath, "utf-8")).trim();
	if (raw.length === 0) {
		throw new Error(`Invalid pid in ${pidPath}`);
	}
	let parsed: Partial<TapdPidRecord>;
	try {
		parsed = JSON.parse(raw) as Partial<TapdPidRecord>;
	} catch (err) {
		throw new Error(`Invalid pidfile at ${pidPath}: ${toErrorMessage(err)}`);
	}
	if (!Number.isInteger(parsed.pid) || !parsed.pid || parsed.pid <= 0) {
		throw new Error(`Invalid pid in ${pidPath}`);
	}
	return {
		pid: parsed.pid,
		binPath: typeof parsed.binPath === "string" ? parsed.binPath : undefined,
		ownerToken: typeof parsed.ownerToken === "string" ? parsed.ownerToken : undefined,
	};
}

async function writeTapdPidRecord(pidPath: string, record: TapdPidRecord): Promise<void> {
	// `wx` = O_CREAT|O_EXCL — fails with EEXIST if the file already exists.
	// This is the lock that closes the check-then-act window between
	// `inspectTapdProcess` and `spawnTapdDetached`: if another process is
	// racing us, exactly one will win the exclusive create and the other
	// will see EEXIST and unwind its spawned child.
	await writeFile(pidPath, JSON.stringify(record), {
		encoding: "utf-8",
		mode: 0o600,
		flag: "wx",
	});
}

function commandLineMatchesTapd(commandLine: string, record: TapdPidRecord): boolean {
	if (record.ownerToken) {
		return commandLine.includes(`${TAPD_OWNER_ARG_PREFIX}${record.ownerToken}`);
	}
	const expectedBinPath = record.binPath ?? resolveTapdBinPath();
	return commandLine.includes(expectedBinPath);
}

/**
 * Reads the command line of a running pid so we can verify the pidfile still
 * points at a tapd process (not a recycled pid owned by an unrelated program).
 *
 * Supported platforms are Linux (reads `/proc/<pid>/cmdline` directly) and
 * macOS (falls back to `ps -o command=`). Windows is out of scope for tap, so
 * there is no PowerShell branch.
 */
async function readProcessCommandLine(pid: number): Promise<string | null> {
	if (process.platform === "linux") {
		try {
			const raw = await readFile(`/proc/${pid}/cmdline`, "utf-8");
			const commandLine = raw.replaceAll("\u0000", " ").trim();
			return commandLine.length > 0 ? commandLine : null;
		} catch (err) {
			if (fsErrorCode(err) === "ENOENT") return null;
			throw err;
		}
	}

	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
		const commandLine = stdout.trim();
		return commandLine.length > 0 ? commandLine : null;
	} catch (err) {
		if ((err as { code?: number }).code === 1) return null;
		throw new Error(`failed to query command line via ps: ${toErrorMessage(err)}`);
	}
}

export async function cleanupTapdStateFiles(dataDir: string): Promise<void> {
	await rm(join(dataDir, TAPD_PID_FILE), { force: true }).catch(() => {});
	await rm(join(dataDir, TAPD_PORT_FILE), { force: true }).catch(() => {});
}

export async function inspectTapdProcess(dataDir: string): Promise<TapdProcessInspection> {
	const pidPath = join(dataDir, TAPD_PID_FILE);
	if (!existsSync(pidPath)) return { status: "missing" };

	let record: TapdPidRecord;
	try {
		record = await readTapdPidRecord(pidPath);
	} catch (err) {
		return {
			status: "mismatch",
			message: `Invalid pidfile at ${pidPath}: ${toErrorMessage(err)}`,
		};
	}

	if (!isProcessAlive(record.pid)) {
		return {
			status: "dead",
			pid: record.pid,
			message: `tapd exited (pidfile was stale for pid ${record.pid})`,
		};
	}

	let commandLine: string | null;
	try {
		commandLine = await readProcessCommandLine(record.pid);
	} catch (err) {
		return {
			status: "unknown",
			pid: record.pid,
			message: `Could not verify tapd ownership for pid ${record.pid}: ${toErrorMessage(err)}`,
		};
	}

	if (!commandLine) {
		return {
			status: "dead",
			pid: record.pid,
			message: `tapd exited (pidfile was stale for pid ${record.pid})`,
		};
	}

	if (commandLineMatchesTapd(commandLine, record)) {
		return { status: "running", pid: record.pid };
	}

	return {
		status: "mismatch",
		pid: record.pid,
		message: `Refusing to signal pid ${record.pid}: pidfile at ${pidPath} does not match a live tapd process.`,
	};
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
	const pidPath = join(options.dataDir, TAPD_PID_FILE);
	const portPath = join(options.dataDir, TAPD_PORT_FILE);

	// Unlink any stale port file from a previous run. Without this, the port
	// wait below can return a stale port from a dead daemon and the caller
	// never notices the new child crashed (finding F3.2).
	await rm(portPath, { force: true }).catch(() => {});

	// Truncate the log on each spawn so users see the current run cleanly.
	const logHandle = await open(logPath, "w", 0o600);
	const ownerToken = randomUUID();
	const child: ChildProcess = spawn(
		process.execPath,
		[binPath, `${TAPD_OWNER_ARG_PREFIX}${ownerToken}`],
		{
			cwd: options.dataDir,
			detached: true,
			stdio: ["ignore", logHandle.fd, logHandle.fd],
			env: {
				...process.env,
				...(options.env ?? {}),
				TAP_DATA_DIR: options.dataDir,
			},
		},
	);
	child.unref();
	await logHandle.close();

	if (!child.pid) {
		throw new Error("Failed to spawn tapd: no pid assigned");
	}

	const childPid = child.pid;
	try {
		await writeTapdPidRecord(pidPath, { pid: childPid, binPath, ownerToken });
	} catch (err) {
		if (fsErrorCode(err) === "EEXIST") {
			// Another tap daemon start raced us and won the exclusive pidfile
			// create. Kill the child we just spawned so we don't leak a
			// headless daemon, then surface a clear error to the caller.
			try {
				process.kill(childPid, "SIGKILL");
			} catch {
				// already gone — ignore
			}
			throw new Error(
				`Another tapd start is in progress (pidfile ${pidPath} already exists). Aborted spawn of pid ${childPid}.`,
			);
		}
		// Unexpected write failure — kill the child so it doesn't become an
		// orphan with no pidfile pointing at it.
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			// already gone — ignore
		}
		throw err;
	}

	const timeoutMs = options.startupTimeoutMs ?? 5_000;
	try {
		const port = await waitForPortFileAndLiveness(portPath, childPid, timeoutMs);
		return { pid: childPid, port, logPath, pidPath };
	} catch (error) {
		// On slow boot, waitForPortFileAndLiveness can time out with the
		// child still alive. Removing the pidfile without killing the child
		// leaves a detached daemon orphaned: `tap daemon stop`/`restart`
		// lose control of it, and the next start may unlink its port file
		// mid-flight while it still holds the port. Kill first, then clean.
		if (isProcessAlive(childPid)) {
			try {
				process.kill(childPid, "SIGKILL");
			} catch {
				// already gone — ignore
			}
		}
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
	const pidPath = join(dataDir, TAPD_PID_FILE);
	const portPath = join(dataDir, TAPD_PORT_FILE);

	if (!existsSync(pidPath)) {
		throw new Error(`No tapd pidfile at ${pidPath}. Is tapd running?`);
	}

	async function cleanupAndReturn(): Promise<number> {
		await cleanupTapdStateFiles(dataDir);
		return pid;
	}

	const inspection = await inspectTapdProcess(dataDir);
	if (inspection.status === "unknown") {
		throw new Error(inspection.message ?? `Could not verify tapd pidfile at ${pidPath}`);
	}
	if (inspection.status === "mismatch") {
		await cleanupTapdStateFiles(dataDir);
		throw new Error(
			`${inspection.message ?? `Refusing to signal pid from ${pidPath}`} Removed stale tapd state files; no signal sent.`,
		);
	}
	if (inspection.status === "missing") {
		throw new Error(`No tapd pidfile at ${pidPath}. Is tapd running?`);
	}

	const pid = inspection.pid!;

	// Fast path — process already gone. Clean up and return.
	if (inspection.status === "dead") return await cleanupAndReturn();

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
