import type { TapEvent, TapEventType } from "./types";

/**
 * SSE wrapper around native browser `EventSource`.
 *
 * Native EventSource cannot set custom headers, so the bearer token travels
 * via `?token=...` query string. tapd accepts that as an auth fallback.
 *
 * On reconnect we forward the last seen event id via `?lastEventId=...` so
 * tapd's event bus can replay anything we missed during the gap.
 *
 * Auth-aware error handling (residual 3): native `EventSource.onerror`
 * surfaces a generic event without an HTTP status code, so we can't tell
 * "tapd restarted and rotated the token" from "transient network blip"
 * purely from SSE. When the stream errors, we probe `GET /api/identity`
 * with the same bearer token — a 401 from the probe means the token is
 * stale and we transition to the dashboard's re-auth screen; any other
 * outcome is treated as transient and left to EventSource's native
 * reconnect.
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

export interface EventStreamOptions {
	/**
	 * Called when the auth probe after an SSE error returns 401 — i.e.
	 * the bearer token is stale because tapd rotated it. The dashboard
	 * wires this to its central re-auth handler so an idle SSE failure
	 * behaves the same as a failing SWR fetch.
	 */
	onUnauthorized?: () => void;
}

export class EventStream {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly handler: EventHandler;
	private readonly onUnauthorized: (() => void) | null;
	private source: EventSource | null = null;
	private lastEventId: string | undefined;
	private authProbeInFlight = false;

	constructor(
		baseUrl: string,
		token: string,
		handler: EventHandler,
		options: EventStreamOptions = {},
	) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.token = token;
		this.handler = handler;
		this.onUnauthorized = options.onUnauthorized ?? null;
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

		source.addEventListener("error", () => {
			// The EventSource spec reconnects automatically on transient
			// failures. We only act when the probe tells us the token
			// itself is stale — otherwise leave the native retry alone.
			void this.probeAuth();
		});

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

	private async probeAuth(): Promise<void> {
		if (!this.onUnauthorized) return;
		if (this.authProbeInFlight) return;
		this.authProbeInFlight = true;
		try {
			const response = await fetch(`${this.baseUrl}/api/identity`, {
				method: "GET",
				headers: { Authorization: `Bearer ${this.token}` },
			});
			if (response.status === 401) {
				// Tear the stream down first so we don't keep banging
				// against a dead token once the dashboard re-auths.
				this.stop();
				this.onUnauthorized?.();
			}
		} catch {
			// Probe failure (network error, CORS, etc.) is indistinguishable
			// from a transient SSE blip — let EventSource keep retrying.
		} finally {
			this.authProbeInFlight = false;
		}
	}
}
