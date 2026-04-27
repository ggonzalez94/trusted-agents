import { readFile } from "node:fs/promises";

export const TAPD_TOKEN_FILE_NAME = ".tapd-token";

export async function readTapdToken(tokenPath: string): Promise<string> {
	const token = (await readFile(tokenPath, "utf-8")).trim();
	if (!token) throw new Error(`tapd token file ${tokenPath} is empty`);
	return token;
}
