export type TapNotificationType = "info" | "escalation" | "auto-reply" | "summary";

export interface TapNotification {
	id: string;
	type: TapNotificationType;
	oneLiner: string;
	createdAt: string;
	data?: Record<string, unknown>;
}

export interface NotificationQueueOptions {
	/**
	 * Maximum number of buffered notifications. When the queue is full,
	 * `enqueue` drops the oldest entry so new events always land — this
	 * queue is a heads-up for consumers, not durable storage. If
	 * `/api/notifications/drain` isn't being called (consumer offline, host
	 * misconfigured), an unbounded buffer would grow indefinitely and could
	 * destabilize the daemon over time; the cap bounds that at a predictable
	 * number of most-recent notifications instead.
	 */
	maxSize?: number;
}

const DEFAULT_MAX_SIZE = 1000;

export class NotificationQueue {
	private buffer: TapNotification[] = [];
	private readonly maxSize: number;

	constructor(options: NotificationQueueOptions = {}) {
		const size = options.maxSize ?? DEFAULT_MAX_SIZE;
		if (!Number.isInteger(size) || size <= 0) {
			throw new Error("NotificationQueue maxSize must be a positive integer");
		}
		this.maxSize = size;
	}

	enqueue(notification: TapNotification): void {
		this.buffer.push(notification);
		if (this.buffer.length > this.maxSize) {
			this.buffer.shift();
		}
	}

	drain(): TapNotification[] {
		const drained = this.buffer;
		this.buffer = [];
		return drained;
	}

	size(): number {
		return this.buffer.length;
	}
}
