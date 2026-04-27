import { readFile, writeFile } from "node:fs/promises";
import { fsErrorCode } from "trusted-agents-core";

export async function readTextFile(path: string): Promise<string> {
	return readFile(path, "utf-8");
}

export async function readTextFileOrNull(path: string): Promise<string | null> {
	try {
		return await readTextFile(path);
	} catch (error: unknown) {
		if (fsErrorCode(error) === "ENOENT") return null;
		throw error;
	}
}

export async function writePrivateTextFile(
	path: string,
	contents: string,
	options: { flag?: string } = {},
): Promise<void> {
	await writeFile(path, contents, {
		encoding: "utf-8",
		mode: 0o600,
		flag: options.flag,
	});
}
