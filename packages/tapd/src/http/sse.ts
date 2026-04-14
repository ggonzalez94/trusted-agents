import type { IncomingMessage, ServerResponse } from "node:http";
import type { TapEvent } from "trusted-agents-core";
import type { EventBus } from "../event-bus.js";

const HEARTBEAT_MS = 30_000;

/**
 * Wires an HTTP request/response pair to the event bus over SSE.
 * Returns a cleanup function the caller invokes when the connection ends.
 *
 * Replay-on-reconnect: if the request includes a `Last-Event-ID` header, all
 * buffered events strictly after that id are written before the live stream
 * begins. Clients without the header start fresh — they only receive events
 * published after they connect.
 */
export function handleSseConnection(
	req: IncomingMessage,
	res: ServerResponse,
	bus: EventBus,
): () => void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-store",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write(": tapd sse stream ready\n\n");

	const lastEventIdHeader = req.headers["last-event-id"];
	const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
	if (lastEventId) {
		for (const event of bus.replayAfter(lastEventId)) {
			writeEvent(res, event);
		}
	}

	const unsubscribe = bus.subscribe((event) => {
		writeEvent(res, event);
	});

	const heartbeat = setInterval(() => {
		res.write(": heartbeat\n\n");
	}, HEARTBEAT_MS);

	const cleanup = () => {
		clearInterval(heartbeat);
		unsubscribe();
	};

	req.on("close", cleanup);
	req.on("error", cleanup);
	res.on("close", cleanup);
	res.on("error", cleanup);

	return cleanup;
}

function writeEvent(res: ServerResponse, event: TapEvent): void {
	const payload = JSON.stringify(event);
	res.write(`id: ${event.id}\n`);
	res.write(`event: ${event.type}\n`);
	res.write(`data: ${payload}\n\n`);
}
