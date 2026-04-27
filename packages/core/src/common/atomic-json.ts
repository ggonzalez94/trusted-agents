import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
