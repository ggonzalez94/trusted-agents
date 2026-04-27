import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";

export async function writeFileAtomic(path: string, content: string): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tempPath = join(dir, `.tmp-${randomUUID()}`);
	await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
	await rename(tempPath, path);
}

export async function readJsonFileOrDefault<T>(
	path: string,
	parse: (raw: unknown) => T,
	fallback: T,
	options: { fallbackOnError?: boolean } = {},
): Promise<T> {
	try {
		return await readJsonFile(path, parse);
	} catch (error: unknown) {
		if (options.fallbackOnError || isMissingFileError(error)) {
			return fallback;
		}
		throw error;
	}
}

export async function readJsonFile<T>(path: string, parse: (raw: unknown) => T): Promise<T> {
	return parse(JSON.parse(await readFile(path, "utf-8")));
}

export async function readYamlFile<T = unknown>(path: string): Promise<T> {
	return YAML.parse(await readFile(path, "utf-8")) as T;
}

export function readYamlFileSync<T = unknown>(path: string): T {
	return YAML.parse(readFileSync(path, "utf-8")) as T;
}

export async function writeJsonFileAtomic(
	path: string,
	data: unknown,
	options: { indent?: string | number } = {},
): Promise<void> {
	await writeFileAtomic(path, JSON.stringify(data, null, options.indent ?? "\t"));
}

export async function writeYamlFileAtomic(path: string, data: unknown): Promise<void> {
	await writeFileAtomic(path, YAML.stringify(data));
}

function isMissingFileError(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
