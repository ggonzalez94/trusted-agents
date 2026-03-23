import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeFileAtomic(path: string, content: string): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tempPath = join(dir, `.tmp-${randomUUID()}`);
	await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
	await rename(tempPath, path);
}
