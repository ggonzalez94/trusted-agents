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

const DEFAULT_MAX_SIZE = 1000;
const EVICTION_PRIORITY: TapNotification["type"][] = ["info", "summary", "auto-reply"];

export class TapNotificationQueue {
	private readonly items: TapNotification[] = [];
	private readonly maxSize: number;

	constructor(maxSize = DEFAULT_MAX_SIZE) {
		this.maxSize = maxSize;
	}

	/** Returns true if the notification was newly enqueued, false if it replaced
	 *  an existing entry with the same messageId (dedup — suppresses wake-up). */
	push(notification: TapNotification): boolean {
		const idx = this.items.findIndex((n) => n.messageId === notification.messageId);
		if (idx !== -1) {
			this.items[idx] = notification;
			return false;
		}
		this.items.push(notification);
		this.evictIfNeeded();
		return true;
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
