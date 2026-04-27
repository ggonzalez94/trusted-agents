import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fsErrorCode } from "trusted-agents-core";
import { TAPD_PORT_FILE } from "./config.js";

export function portFilePath(dataDir: string): string {
	return join(dataDir, TAPD_PORT_FILE);
}

export async function persistBoundPort(dataDir: string, port: number): Promise<void> {
	await writeFile(portFilePath(dataDir), String(port), {
		encoding: "utf-8",
		mode: 0o600,
	});
}

export async function loadBoundPort(dataDir: string): Promise<number | null> {
	try {
		return parseBoundPort(await readFile(portFilePath(dataDir), "utf-8"));
	} catch (error: unknown) {
		if (fsErrorCode(error) === "ENOENT") return null;
		throw error;
	}
}

export function parseBoundPort(raw: string): number | null {
	const port = Number.parseInt(raw.trim(), 10);
	return Number.isInteger(port) && port > 0 ? port : null;
}
