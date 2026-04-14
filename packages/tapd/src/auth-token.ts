import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_FILE = ".tapd-token";

export function generateAuthToken(): string {
	return randomBytes(16).toString("hex");
}

export async function persistAuthToken(dataDir: string, token: string): Promise<void> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, TOKEN_FILE);
	await writeFile(path, token, { encoding: "utf-8", mode: 0o600 });
}

export async function loadAuthToken(dataDir: string): Promise<string | null> {
	try {
		const contents = await readFile(join(dataDir, TOKEN_FILE), "utf-8");
		return contents.trim() || null;
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}

export function tokenFilePath(dataDir: string): string {
	return join(dataDir, TOKEN_FILE);
}
