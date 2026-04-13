import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_RETRY_MIN_MS = 15;
const LOCK_RETRY_MAX_MS = 60;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

interface LockFileContents {
	pid: number;
	createdAt: string;
	token: string;
}

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	const token = randomUUID();
	await acquireFileLock(lockPath, token);
	try {
		return await fn();
	} finally {
		await releaseFileLock(lockPath, token);
	}
}

async function acquireFileLock(lockPath: string, token: string): Promise<void> {
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	const contents: LockFileContents = {
		pid: process.pid,
		createdAt: new Date().toISOString(),
		token,
	};

	for (;;) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(JSON.stringify(contents, null, "\t"), { encoding: "utf-8" });
			await handle.close();
			return;
		} catch (error: unknown) {
			const errno = error as NodeJS.ErrnoException;
			if (errno.code !== "EEXIST") {
				throw error;
			}
			await cleanupStaleLock(lockPath);
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for Hermes TAP file lock: ${lockPath}`);
			}
			await sleep(randomBetween(LOCK_RETRY_MIN_MS, LOCK_RETRY_MAX_MS));
		}
	}
}

async function cleanupStaleLock(lockPath: string): Promise<void> {
	try {
		const raw = await readFile(lockPath, "utf-8");
		let parsed: Partial<LockFileContents> | null = null;
		try {
			parsed = JSON.parse(raw) as Partial<LockFileContents>;
		} catch {
			parsed = null;
		}

		const fileStat = await stat(lockPath);
		const createdAt =
			parsed && typeof parsed.createdAt === "string"
				? Date.parse(parsed.createdAt)
				: fileStat.mtimeMs;
		const pid = parsed && typeof parsed.pid === "number" ? parsed.pid : null;
		const staleByTime = Number.isFinite(createdAt) && Date.now() - createdAt >= LOCK_STALE_MS;
		const deadPid = pid !== null && !isProcessAlive(pid);
		if (staleByTime || deadPid) {
			await rm(lockPath, { force: true });
		}
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return;
		}
	}
}

async function releaseFileLock(lockPath: string, token: string): Promise<void> {
	try {
		const raw = await readFile(lockPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<LockFileContents>;
		if (parsed.token === token) {
			await rm(lockPath, { force: true });
		}
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function randomBetween(minMs: number, maxMs: number): number {
	return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}
