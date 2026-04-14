import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

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

	const { writeFile } = await import("node:fs/promises");
	await writeFile(pidPath, String(child.pid), { encoding: "utf-8", mode: 0o600 });

	const timeoutMs = options.startupTimeoutMs ?? 5_000;
	const port = await waitForPortFile(portPath, timeoutMs);
	return { pid: child.pid, port, logPath, pidPath };
}

/**
 * Stops a running tapd by reading the pidfile, sending SIGTERM, and waiting
 * for the port file to disappear. Removes both files when shutdown completes.
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

	try {
		process.kill(pid, "SIGTERM");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") {
			// Process already gone — clean up files and return.
			await rm(pidPath, { force: true }).catch(() => {});
			await rm(portPath, { force: true }).catch(() => {});
			return pid;
		}
		throw err;
	}

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!existsSync(portPath)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	await rm(pidPath, { force: true }).catch(() => {});
	return pid;
}

async function waitForPortFile(portPath: string, timeoutMs: number): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const raw = await readFile(portPath, "utf-8");
			const port = Number.parseInt(raw.trim(), 10);
			if (Number.isInteger(port) && port > 0) return port;
		} catch {
			// not yet
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Timed out waiting for tapd to bind a port (${portPath})`);
}
