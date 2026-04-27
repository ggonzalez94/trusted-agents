import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "../common/atomic-json.js";
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
			if (
				err &&
				typeof err === "object" &&
				"code" in err &&
				(err as { code: string }).code === "ENOENT"
			) {
				return {};
			}
			throw err;
		}
	}

	private async save(data: Record<string, unknown>): Promise<void> {
		await writeJsonFileAtomic(this.filePath, data, { tempPrefix: ".state" });
	}
}
