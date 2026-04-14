import type { TapEvent } from "trusted-agents-core";

export interface EventBusOptions {
	/** Number of events retained for SSE Last-Event-ID replay. */
	ringBufferSize: number;
}

export type EventHandler = (event: TapEvent) => void;

/**
 * In-memory pub/sub for typed `TapEvent`s. Used by tapd as the fan-out point
 * between the runtime layer (which publishes events) and the HTTP layer (where
 * SSE clients subscribe).
 *
 * The ring buffer enables SSE clients reconnecting with `Last-Event-ID` to
 * replay events they missed. The buffer is bounded — old events drop off the
 * front when the bus exceeds `ringBufferSize`. This is intentional: the event
 * bus is a notification mechanism, not durable storage.
 */
export class EventBus {
	private readonly ringBufferSize: number;
	private readonly buffer: TapEvent[] = [];
	private readonly handlers = new Set<EventHandler>();

	constructor(options: EventBusOptions) {
		if (options.ringBufferSize <= 0) {
			throw new Error("ringBufferSize must be a positive integer");
		}
		this.ringBufferSize = options.ringBufferSize;
	}

	publish(event: TapEvent): void {
		this.buffer.push(event);
		if (this.buffer.length > this.ringBufferSize) {
			this.buffer.shift();
		}

		for (const handler of this.handlers) {
			try {
				handler(event);
			} catch {
				// Isolate handler errors so one bad subscriber doesn't break the others.
				// We deliberately swallow here; tapd's HTTP layer logs separately.
			}
		}
	}

	subscribe(handler: EventHandler): () => void {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}

	snapshot(): TapEvent[] {
		return [...this.buffer];
	}

	/**
	 * Returns events strictly after the given event id (in publish order).
	 * If the id is unknown to the buffer (or undefined), returns the entire
	 * buffer — this matches SSE Last-Event-ID semantics: unknown id means
	 * "the client missed everything currently in the buffer."
	 */
	replayAfter(lastEventId: string | undefined): TapEvent[] {
		if (lastEventId === undefined) {
			return [];
		}
		const index = this.buffer.findIndex((event) => event.id === lastEventId);
		if (index === -1) {
			return this.snapshot();
		}
		return this.buffer.slice(index + 1);
	}
}
