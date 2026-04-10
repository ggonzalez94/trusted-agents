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
const HARD_CAP_MULTIPLIER = 2;
const EVICTION_PRIORITY: TapNotification["type"][] = ["info", "summary", "auto-reply"];
const OVERFLOW_SENTINEL_ID = "__tap_queue_overflow__";

export interface TapNotificationQueueOptions {
	maxSize?: number;
	onHardCapDrop?: (dropped: TapNotification) => void;
}

export class TapNotificationQueue {
	private readonly items: TapNotification[] = [];
	private readonly maxSize: number;
	private readonly hardCap: number;
	private readonly onHardCapDrop?: (dropped: TapNotification) => void;
	private droppedEscalationCount = 0;

	constructor(optionsOrMaxSize: TapNotificationQueueOptions | number = {}) {
		const options =
			typeof optionsOrMaxSize === "number" ? { maxSize: optionsOrMaxSize } : optionsOrMaxSize;
		this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
		this.hardCap = this.maxSize * HARD_CAP_MULTIPLIER;
		this.onHardCapDrop = options.onHardCapDrop;
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
		const drained = this.items.splice(0);
		if (this.droppedEscalationCount > 0) {
			// Always emit a synthetic overflow notification so the agent is told
			// to reconcile via list_pending. Without this, dropped escalations
			// would leave pending approvals in the journal with no visible signal
			// in the agent's [TAP Notifications] context.
			const count = this.droppedEscalationCount;
			this.droppedEscalationCount = 0;
			drained.push({
				type: "escalation",
				identity: "",
				timestamp: new Date().toISOString(),
				method: "tap/queue-overflow",
				from: 0,
				messageId: OVERFLOW_SENTINEL_ID,
				detail: { droppedEscalations: count },
				oneLiner: `TAP notification queue dropped ${count} escalation${count === 1 ? "" : "s"} due to overflow. Run \`tap_gateway list_pending\` to recover missed approvals, then drain the queue.`,
			});
		}
		return drained;
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
		// Only escalations remain. Allow a bounded overflow so transient bursts
		// don't lose critical notifications, but enforce a hard cap to prevent
		// unbounded memory growth. When the hard cap is hit we drop the oldest
		// escalation AND mark the queue as overflowed — drain() will then emit
		// a synthetic sentinel so the agent sees a recovery instruction. The
		// underlying request is still in the journal and reachable via
		// `tap_gateway list_pending`.
		if (this.items.length > this.hardCap) {
			const dropped = this.items.shift();
			if (dropped) {
				this.droppedEscalationCount += 1;
				if (this.onHardCapDrop) {
					try {
						this.onHardCapDrop(dropped);
					} catch {
						// Drop hook errors — notification loss is already being reported.
					}
				}
			}
		}
	}
}
