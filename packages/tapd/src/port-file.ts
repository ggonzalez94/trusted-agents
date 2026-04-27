import { join } from "node:path";
import { TAPD_PORT_FILE } from "./config.js";
import { readTextFileOrNull, writePrivateTextFile } from "./private-file.js";

export function portFilePath(dataDir: string): string {
	return join(dataDir, TAPD_PORT_FILE);
}

export async function persistBoundPort(dataDir: string, port: number): Promise<void> {
	await writePrivateTextFile(portFilePath(dataDir), String(port));
}

export async function loadBoundPort(dataDir: string): Promise<number | null> {
	const raw = await readTextFileOrNull(portFilePath(dataDir));
	return raw === null ? null : parseBoundPort(raw);
}

export function parseBoundPort(raw: string): number | null {
	const port = Number.parseInt(raw.trim(), 10);
	return Number.isInteger(port) && port > 0 ? port : null;
}
