export interface TapNotification {
	type: "summary" | "escalation" | "info";
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

const DEFAULT_MAX_SIZE = 1000;
const EVICTION_PRIORITY: TapNotification["type"][] = ["info", "summary"];

export class TapNotificationQueue {
	private readonly items: TapNotification[] = [];
	private readonly maxSize: number;

	constructor(maxSize = DEFAULT_MAX_SIZE) {
		this.maxSize = maxSize;
	}

	push(notification: TapNotification): void {
		this.items.push(notification);
		this.evictIfNeeded();
	}

	upgrade(
		messageId: string,
		newType: TapNotification["type"],
		updates?: Partial<Pick<TapNotification, "oneLiner" | "detail" | "requestId">>,
	): void {
		const item = this.items.find((n) => n.messageId === messageId);
		if (!item) return;
		item.type = newType;
		if (updates) {
			if (updates.oneLiner !== undefined) item.oneLiner = updates.oneLiner;
			if (updates.detail !== undefined) item.detail = updates.detail;
			if (updates.requestId !== undefined) item.requestId = updates.requestId;
		}
	}

	drain(): TapNotification[] {
		return this.items.splice(0);
	}

	peek(): TapNotification[] {
		return [...this.items];
	}

	private evictIfNeeded(): void {
		if (this.items.length <= this.maxSize) return;
		for (const evictType of EVICTION_PRIORITY) {
			const index = this.items.findIndex((n) => n.type === evictType);
			if (index !== -1) {
				this.items.splice(index, 1);
				return;
			}
		}
		// Only escalations remain — allow overflow
	}
}
