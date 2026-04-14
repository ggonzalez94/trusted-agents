import type { IncomingMessage, ServerResponse } from "node:http";
import type { TapEvent } from "trusted-agents-core";
import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/event-bus.js";
import { handleSseConnection } from "../../src/http/sse.js";

function makeEvent(seq: number): TapEvent {
	return {
		id: `evt-${seq}`,
		type: "daemon.status",
		occurredAt: new Date().toISOString(),
		identityAgentId: 1,
		transportConnected: true,
	};
}

function makeRes(): ServerResponse & {
	writes: string[];
	headers: Record<string, string | number>;
	statusCode: number;
} {
	const writes: string[] = [];
	const headers: Record<string, string | number> = {};
	let ended = false;
	const handlers: Record<string, () => void> = {};
	const res: Partial<ServerResponse> & {
		writes: string[];
		headers: typeof headers;
		statusCode: number;
	} = {
		writes,
		headers,
		statusCode: 0,
		writeHead(status: number, hdrs?: Record<string, string | number>) {
			res.statusCode = status;
			Object.assign(headers, hdrs ?? {});
			return res as ServerResponse;
		},
		write(chunk: string | Uint8Array): boolean {
			if (ended) return false;
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
			return true;
		},
		end(): ServerResponse {
			ended = true;
			handlers.close?.();
			return res as ServerResponse;
		},
		on(event: string, handler: () => void): ServerResponse {
			handlers[event] = handler;
			return res as ServerResponse;
		},
		off(): ServerResponse {
			return res as ServerResponse;
		},
	};
	return res as never;
}

function makeReq(lastEventId?: string): IncomingMessage {
	const handlers: Record<string, () => void> = {};
	return {
		headers: lastEventId ? { "last-event-id": lastEventId } : {},
		on(event: string, handler: () => void) {
			handlers[event] = handler;
			return this;
		},
		off() {
			return this;
		},
	} as never;
}

describe("handleSseConnection", () => {
	it("writes SSE headers and replays buffered events for new clients", async () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		bus.publish(makeEvent(1));
		bus.publish(makeEvent(2));

		const req = makeReq();
		const res = makeRes();
		const cleanup = handleSseConnection(req, res, bus);

		expect(res.statusCode).toBe(200);
		expect(res.headers["Content-Type"]).toBe("text/event-stream");
		// New client (no Last-Event-ID) should NOT replay buffered events.
		expect(res.writes.join("")).not.toContain("evt-1");

		cleanup();
	});

	it("delivers new events as they are published", async () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		const req = makeReq();
		const res = makeRes();
		const cleanup = handleSseConnection(req, res, bus);

		bus.publish(makeEvent(1));
		bus.publish(makeEvent(2));

		const written = res.writes.join("");
		expect(written).toContain("id: evt-1");
		expect(written).toContain("event: daemon.status");
		expect(written).toContain("id: evt-2");
		cleanup();
	});

	it("replays events after Last-Event-ID for reconnecting clients", async () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		bus.publish(makeEvent(1));
		bus.publish(makeEvent(2));
		bus.publish(makeEvent(3));

		const req = makeReq("evt-1");
		const res = makeRes();
		const cleanup = handleSseConnection(req, res, bus);

		const written = res.writes.join("");
		expect(written).toContain("id: evt-2");
		expect(written).toContain("id: evt-3");
		expect(written).not.toContain("id: evt-1");
		cleanup();
	});

	it("stops sending events after cleanup", async () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		const req = makeReq();
		const res = makeRes();
		const cleanup = handleSseConnection(req, res, bus);

		bus.publish(makeEvent(1));
		const beforeWrites = res.writes.length;

		cleanup();
		bus.publish(makeEvent(2));
		expect(res.writes.length).toBe(beforeWrites);
	});
});
