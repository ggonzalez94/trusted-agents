import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tokenFilePath } from "trusted-agents-tapd";

export function tapdTokenPathForSocket(socketPath: string): string {
	return tokenFilePath(dirname(socketPath));
}

export async function readTapdToken(tokenPath: string): Promise<string> {
	const token = (await readFile(tokenPath, "utf-8")).trim();
	if (!token) throw new Error(`tapd token file ${tokenPath} is empty`);
	return token;
}
