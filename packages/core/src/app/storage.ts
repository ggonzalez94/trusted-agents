import { join } from "node:path";
import { readJsonFileOrDefault, writeJsonFileAtomic } from "../common/atomic-json.js";
import { AsyncMutex } from "../common/index.js";
import type { TapAppStorage } from "./types.js";

export const TAP_APPS_DIR = "apps";
export const TAP_APP_STATE_FILE = "state.json";

export function appDataDirPath(dataDir: string, appId: string): string {
	return join(dataDir, TAP_APPS_DIR, appId);
}

export function appStatePath(dataDir: string, appId: string): string {
	return join(appDataDirPath(dataDir, appId), TAP_APP_STATE_FILE);
}

export class FileAppStorage implements TapAppStorage {
	private readonly filePath: string;
	private readonly writeMutex = new AsyncMutex();

	constructor(dataDir: string, appId: string) {
		this.filePath = appStatePath(dataDir, appId);
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
		return readJsonFileOrDefault(this.filePath, (raw) => raw as Record<string, unknown>, {});
	}

	private async save(data: Record<string, unknown>): Promise<void> {
		await writeJsonFileAtomic(this.filePath, data, { tempPrefix: ".state" });
	}
}
