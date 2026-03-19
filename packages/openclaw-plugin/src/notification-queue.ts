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
		if (this.items.some((n) => n.messageId === notification.messageId)) return;
		this.items.push(notification);
		this.evictIfNeeded();
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
