import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AsyncMutex } from "../common/index.js";
import type { TapAppStorage } from "./types.js";

export class FileAppStorage implements TapAppStorage {
	private readonly filePath: string;
	private readonly writeMutex = new AsyncMutex();

	constructor(dataDir: string, appId: string) {
		this.filePath = join(dataDir, "apps", appId, "state.json");
	}

	async get(key: string): Promise<unknown | undefined> {
		const data = await this.load();
		return data[key];
	}

	async set(key: string, value: unknown): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const data = await this.load();
			data[key] = value;
			await this.save(data);
		});
	}

	async delete(key: string): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const data = await this.load();
			delete data[key];
			await this.save(data);
		});
	}

	async list(prefix?: string): Promise<Record<string, unknown>> {
		const data = await this.load();
		if (!prefix) return { ...data };
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) {
			if (k.startsWith(prefix)) {
				result[k] = v;
			}
		}
		return result;
	}

	private async load(): Promise<Record<string, unknown>> {
		try {
			const content = await readFile(this.filePath, "utf-8");
			return JSON.parse(content) as Record<string, unknown>;
		} catch (err: unknown) {
			if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
				return {};
			}
			throw err;
		}
	}

	private async save(data: Record<string, unknown>): Promise<void> {
		const dir = dirname(this.filePath);
		await mkdir(dir, { recursive: true });
		const tmpPath = join(dir, `.state-${randomUUID()}.tmp`);
		await writeFile(tmpPath, JSON.stringify(data, null, "\t"), { mode: 0o600 });
		await rename(tmpPath, this.filePath);
	}
}
