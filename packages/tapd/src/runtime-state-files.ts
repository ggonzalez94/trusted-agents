import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tokenFilePath } from "./auth-token.js";
import { TAPD_LOG_FILE } from "./config.js";
import { portFilePath } from "./port-file.js";

export function logFilePath(dataDir: string): string {
	return join(dataDir, TAPD_LOG_FILE);
}

export async function cleanupTapdRuntimeStateFiles(dataDir: string): Promise<void> {
	await Promise.all([
		rm(portFilePath(dataDir), { force: true }).catch(() => {}),
		rm(tokenFilePath(dataDir), { force: true }).catch(() => {}),
	]);
}
