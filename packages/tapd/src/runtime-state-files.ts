import { rm } from "node:fs/promises";
import { tokenFilePath } from "./auth-token.js";
import { portFilePath } from "./port-file.js";

export async function cleanupTapdRuntimeStateFiles(dataDir: string): Promise<void> {
	await Promise.all([
		rm(portFilePath(dataDir), { force: true }).catch(() => {}),
		rm(tokenFilePath(dataDir), { force: true }).catch(() => {}),
	]);
}
