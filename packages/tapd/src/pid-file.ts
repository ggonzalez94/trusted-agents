import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toErrorMessage } from "trusted-agents-core";
import { TAPD_PID_FILE } from "./config.js";
import { writePrivateTextFile } from "./private-file.js";

export interface TapdPidRecord {
	pid: number;
	binPath?: string;
	ownerToken?: string;
}

export function pidFilePath(dataDir: string): string {
	return join(dataDir, TAPD_PID_FILE);
}

export async function loadTapdPidRecord(pidPath: string): Promise<TapdPidRecord> {
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

export async function persistTapdPidRecordExclusive(
	pidPath: string,
	record: TapdPidRecord,
): Promise<void> {
	// `wx` = O_CREAT|O_EXCL. Callers use this as the cross-process guard
	// against two detached tapd starts clobbering each other's pidfile.
	await writePrivateTextFile(pidPath, JSON.stringify(record), { flag: "wx" });
}
