import type { TapEvent, TapEventType } from "./types.js";

/**
 * SSE wrapper around native browser `EventSource`.
 *
 * Native EventSource cannot set custom headers, so the bearer token travels
 * via `?token=...` query string. tapd accepts that as an auth fallback.
 *
 * On reconnect we forward the last seen event id via `?lastEventId=...` so
 * tapd's event bus can replay anything we missed during the gap.
 */

const EVENT_TYPES: TapEventType[] = [
	"message.received",
	"message.sent",
	"action.requested",
	"action.completed",
	"action.failed",
	"action.pending",
	"pending.resolved",
	"connection.requested",
	"connection.established",
	"connection.failed",
	"contact.updated",
	"daemon.status",
];

export type EventHandler = (event: TapEvent) => void;

export class EventStream {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly handler: EventHandler;
	private source: EventSource | null = null;
	private lastEventId: string | undefined;

	constructor(baseUrl: string, token: string, handler: EventHandler) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.token = token;
		this.handler = handler;
	}

	start(): void {
		if (this.source) return;
		this.connect();
	}

	stop(): void {
		if (this.source) {
			this.source.close();
			this.source = null;
		}
	}

	reconnect(): void {
		this.stop();
		this.connect();
	}

	private connect(): void {
		const url = new URL(`${this.baseUrl}/api/events/stream`);
		url.searchParams.set("token", this.token);
		if (this.lastEventId) {
			url.searchParams.set("lastEventId", this.lastEventId);
		}
		const source = new EventSource(url.toString());
		this.source = source;

		for (const type of EVENT_TYPES) {
			source.addEventListener(type, (event: MessageEvent) => {
				try {
					const payload = JSON.parse(event.data) as TapEvent;
					this.lastEventId = payload.id;
					this.handler(payload);
				} catch {
					// Malformed event — drop silently. tapd is a trusted local source.
				}
			});
		}
	}
}
