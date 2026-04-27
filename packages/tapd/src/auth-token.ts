import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TAPD_TOKEN_FILE } from "./config.js";
import { readTextFileOrNull, writePrivateTextFile } from "./private-file.js";

export function generateAuthToken(): string {
	return randomBytes(16).toString("hex");
}

export async function persistAuthToken(dataDir: string, token: string): Promise<void> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	await writePrivateTextFile(tokenFilePath(dataDir), token);
}

export async function loadAuthToken(dataDir: string): Promise<string | null> {
	const contents = await readTextFileOrNull(tokenFilePath(dataDir));
	return contents?.trim() || null;
}

export function tokenFilePath(dataDir: string): string {
	return join(dataDir, TAPD_TOKEN_FILE);
}
