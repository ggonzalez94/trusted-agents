import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";

export async function writeFileAtomic(path: string, content: string): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tempPath = join(dir, `.tmp-${randomUUID()}`);
	await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
	await rename(tempPath, path);
}

export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
	await writeFileAtomic(path, JSON.stringify(data, null, "\t"));
}

export async function writeYamlFileAtomic(path: string, data: unknown): Promise<void> {
	await writeFileAtomic(path, YAML.stringify(data));
}
