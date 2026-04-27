import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

export async function readJsonFileOrDefault<T>(
	path: string,
	parse: (raw: unknown) => T,
	fallback: T,
	options: { fallbackOnError?: boolean } = {},
): Promise<T> {
	try {
		return parse(JSON.parse(await readFile(path, "utf-8")));
	} catch (error: unknown) {
		if (options.fallbackOnError || isNotFound(error)) {
			return fallback;
		}
		throw error;
	}
}

export async function writeJsonFileAtomic(
	path: string,
	data: unknown,
	options: { directoryMode?: number; tempPrefix?: string } = {},
): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: options.directoryMode });
	const tempPath = join(dir, `${options.tempPrefix ?? ".tmp"}-${randomUUID()}.tmp`);
	await writeFile(tempPath, JSON.stringify(data, null, "\t"), {
		encoding: "utf-8",
		mode: 0o600,
	});
	await rename(tempPath, path);
}
