export type TapNotificationType = "info" | "escalation" | "auto-reply" | "summary";

export interface TapNotification {
	id: string;
	type: TapNotificationType;
	oneLiner: string;
	createdAt: string;
	data?: Record<string, unknown>;
}

export class NotificationQueue {
	private buffer: TapNotification[] = [];

	enqueue(notification: TapNotification): void {
		this.buffer.push(notification);
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
