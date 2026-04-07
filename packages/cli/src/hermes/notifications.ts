import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/atomic-write.js";
import { withFileLock } from "./file-lock.js";

export interface TapNotification {
	type: "summary" | "escalation" | "info" | "auto-reply";
	identity: string;
	timestamp: string;
	method: string;
	from: number;
	fromName?: string;
	messageId: string;
	requestId?: string;
	detail: Record<string, unknown>;
	oneLiner: string;
}

interface TapNotificationFile {
	items: TapNotification[];
}

const DEFAULT_MAX_SIZE = 1000;
const EVICTION_PRIORITY: TapNotification["type"][] = ["info", "summary", "auto-reply"];

export class FileTapHermesNotificationStore {
	private readonly filePath: string;
	private readonly lockPath: string;
	private readonly maxSize: number;

	constructor(stateDir: string, maxSize = DEFAULT_MAX_SIZE) {
		this.filePath = join(stateDir, "notifications.json");
		this.lockPath = join(stateDir, "notifications.lock");
		this.maxSize = maxSize;
	}

	async push(notification: TapNotification): Promise<boolean> {
		return await withFileLock(this.lockPath, async () => {
			const current = await this.load();
			const existingIndex = current.items.findIndex(
				(item) =>
					item.identity === notification.identity && item.messageId === notification.messageId,
			);
			if (existingIndex !== -1) {
				current.items[existingIndex] = notification;
				await this.save(current);
				return false;
			}
			current.items.push(notification);
			this.evictIfNeeded(current.items);
			await this.save(current);
			return true;
		});
	}

	async peek(): Promise<TapNotification[]> {
		return await withFileLock(this.lockPath, async () => {
			const current = await this.load();
			return [...current.items];
		});
	}

	async drain(): Promise<TapNotification[]> {
		return await withFileLock(this.lockPath, async () => {
			const current = await this.load();
			await this.save({ items: [] });
			return [...current.items];
		});
	}

	private async load(): Promise<TapNotificationFile> {
		try {
			const raw = await readFile(this.filePath, "utf-8");
			const parsed = JSON.parse(raw) as Partial<TapNotificationFile>;
			if (!Array.isArray(parsed.items)) {
				return { items: [] };
			}
			return { items: parsed.items.filter(isTapNotification) };
		} catch (error: unknown) {
			if (
				error instanceof Error &&
				"code" in error &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return { items: [] };
			}
			throw error;
		}
	}

	private async save(data: TapNotificationFile): Promise<void> {
		await writeFileAtomic(this.filePath, JSON.stringify(data, null, "\t"));
	}

	private evictIfNeeded(items: TapNotification[]): void {
		while (items.length > this.maxSize) {
			let removed = false;
			for (const evictType of EVICTION_PRIORITY) {
				const index = items.findIndex((item) => item.type === evictType);
				if (index !== -1) {
					items.splice(index, 1);
					removed = true;
					break;
				}
			}
			if (!removed) {
				items.shift();
			}
		}
	}
}

function isTapNotification(value: unknown): value is TapNotification {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const item = value as Partial<TapNotification>;
	return (
		typeof item.type === "string" &&
		typeof item.identity === "string" &&
		typeof item.timestamp === "string" &&
		typeof item.method === "string" &&
		typeof item.from === "number" &&
		typeof item.messageId === "string" &&
		typeof item.oneLiner === "string" &&
		typeof item.detail === "object" &&
		item.detail !== null &&
		!Array.isArray(item.detail)
	);
}
