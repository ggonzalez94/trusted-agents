# tapd Phase 1: Daemon Greenfield Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `packages/tapd` workspace — a long-lived daemon that owns transport via `TapMessagingService` and exposes a local HTTP API on a Unix socket and localhost TCP. At end of Phase 1, the binary builds and runs against a temp data dir; nothing else in the repo references it yet.

**Architecture:** New workspace package wrapping `TapMessagingService` from `trusted-agents-core`. Raw `node:http` server bound to both a Unix socket and localhost TCP. Bearer-token auth on TCP only. In-memory event bus with bounded ring buffer for SSE replay. All read endpoints are thin shims over existing `FileTrustStore`, `FileConversationLogger`, `FileRequestJournal`. Write endpoints route through `TapMessagingService.resolvePending`. The event-classifier moves from `packages/openclaw-plugin/src/event-classifier.ts` into `packages/core/src/runtime/event-classifier.ts` so tapd can use it host-agnostically.

**Tech stack:** TypeScript (strict), `node:http`, `node:net`, vitest. **No new runtime dependencies.** Reuses `trusted-agents-core` and the existing transport-owner lock pattern.

**Code-quality bar:** Every new file has one clear responsibility. No file exceeds ~250 lines. TDD throughout — tests written before implementation. Frequent commits per task. No placeholder code.

**Out of scope for Phase 1:** service-manager registration (launchctl/systemd), CLI thin-client refactor, OpenClaw/Hermes plugin migration, web UI, lazy auto-start. Those come in later phases.

**Note for executors — TDD is the iron law.** This plan was written by reading the existing core API surface once, but core types and method names may have shifted under it. **The test you write is the contract**, not the example code in the task description. If you hit a TypeScript error or a runtime failure that says "method X does not exist on Y," go read the actual source file (`packages/core/src/...`), use the real method name, update both the test and the implementation, and commit. The plan's example code is a starting sketch — get the test to pass against the real types, then move on.

Before each task, glance at any new third-party API references (e.g., `ITrustStore.getContacts`, `TapMessagingService.resolvePending`, `OwsSigningProvider` constructor) and verify them against the source. Spend 30 seconds confirming the signature; do not spend 5 minutes guessing.

---

## File map

**Created in `packages/tapd/`:**

```
packages/tapd/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                      # public exports
    bin.ts                        # daemon entrypoint
    daemon.ts                     # lifecycle: start/stop, signal handling, lock acquisition
    runtime.ts                    # holds TapMessagingService, bridges emitEvent → bus
    config.ts                     # tapd configuration loading
    event-bus.ts                  # in-memory pub/sub with bounded ring buffer
    auth-token.ts                 # bearer token generation, persistence, validation
    http/
      server.ts                   # http.Server bound to Unix socket + TCP
      router.ts                   # path/method dispatcher
      response.ts                 # JSON / SSE response helpers
      sse.ts                      # SSE writer + Last-Event-ID replay
      auth.ts                     # bearer token middleware
      routes/
        identity.ts               # GET /api/identity
        contacts.ts               # GET /api/contacts, GET /api/contacts/:id
        conversations.ts          # GET /api/conversations*, POST /api/conversations/:id/mark-read
        pending.ts                # GET /api/pending, POST /api/pending/:id/{approve,deny}
        notifications.ts          # GET /api/notifications/drain
        events.ts                 # GET /api/events/stream
        daemon-control.ts         # GET /daemon/health, POST /daemon/sync, POST /daemon/shutdown
  test/
    helpers/
      loopback-transport.ts       # minimal in-memory TransportProvider for tests
      tapd-fixture.ts             # spin up tapd against a temp data dir
    unit/
      event-bus.test.ts
      auth-token.test.ts
      router.test.ts
      runtime.test.ts
      routes/
        identity.test.ts
        contacts.test.ts
        conversations.test.ts
        pending.test.ts
        notifications.test.ts
        events.test.ts
        daemon-control.test.ts
    integration/
      http-end-to-end.test.ts
      sse-replay.test.ts
      lifecycle.test.ts
```

**Modified in `packages/core/`:**

```
packages/core/src/runtime/
  event-classifier.ts             # NEW (moved from openclaw-plugin)
  event-types.ts                  # NEW (typed discriminated union for emitEvent)
  index.ts                        # export both new files
  service.ts                      # type emitEvent payload (backwards-compatible)
packages/core/test/unit/runtime/
  event-classifier.test.ts        # NEW (moved from openclaw-plugin tests)
```

**Modified in `packages/openclaw-plugin/`:**

```
packages/openclaw-plugin/src/
  event-classifier.ts             # becomes a re-export from trusted-agents-core
```

**Modified in `packages/cli/src/hermes/`:**

```
packages/cli/src/hermes/
  event-classifier.ts             # becomes a re-export from trusted-agents-core
```

**Workspace root:**

```
package.json                      # add packages/tapd to typecheck order
```

The hermes daemon code (`packages/cli/src/hermes/{daemon,client,ipc,registry,...}.ts`) is **not touched in Phase 1**. tapd is built fresh, modeled after hermes patterns where useful. Hermes users keep working on the existing daemon throughout Phase 1.

---

## Task 1: Scaffold `packages/tapd` workspace

**Files:**
- Create: `packages/tapd/package.json`
- Create: `packages/tapd/tsconfig.json`
- Create: `packages/tapd/vitest.config.ts`
- Create: `packages/tapd/src/index.ts`
- Modify: `package.json` (workspace root)

- [ ] **Step 1: Create `packages/tapd/package.json`**

```json
{
  "name": "trusted-agents-tapd",
  "version": "0.2.0-beta.6",
  "description": "Long-lived TAP daemon owning transport and serving a local HTTP API",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "tapd": "./dist/bin.js"
  },
  "files": [
    "dist"
  ],
  "engines": {
    "node": ">=18"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "bun run --cwd ../core build && tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "trusted-agents-core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.3.3",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/tapd/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "test"]
}
```

- [ ] **Step 3: Create `packages/tapd/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 10000,
  },
});
```

- [ ] **Step 4: Create `packages/tapd/src/index.ts` placeholder**

```ts
export const TAPD_VERSION = "0.2.0-beta.6";
```

- [ ] **Step 5: Add tapd to workspace typecheck order**

Edit `package.json` at the repo root. Find the `typecheck` script and append a tapd build step before the cli build:

```
"typecheck": "bun run --cwd packages/core typecheck && bun run --cwd packages/core build && bun run --cwd packages/app-transfer typecheck && bun run --cwd packages/app-scheduling typecheck && bun run --cwd packages/sdk typecheck && bun run --cwd packages/sdk build && bun run --cwd packages/tapd typecheck && bun run --cwd packages/cli typecheck && bun run --cwd packages/openclaw-plugin typecheck",
```

- [ ] **Step 6: Install workspace dependencies**

Run: `bun install`
Expected: lockfile updated, `packages/tapd/node_modules` populated with workspace links.

- [ ] **Step 7: Verify typecheck passes**

Run: `bun run typecheck`
Expected: all packages including tapd typecheck cleanly with no errors.

- [ ] **Step 8: Verify lint passes**

Run: `bun run lint`
Expected: no lint errors.

- [ ] **Step 9: Commit**

```bash
git add packages/tapd/package.json packages/tapd/tsconfig.json packages/tapd/vitest.config.ts packages/tapd/src/index.ts package.json bun.lock
git commit -m "feat(tapd): scaffold packages/tapd workspace"
```

---

## Task 2: Move event-classifier into core

**Files:**
- Create: `packages/core/src/runtime/event-classifier.ts`
- Create: `packages/core/test/unit/runtime/event-classifier.test.ts`
- Modify: `packages/core/src/runtime/index.ts`
- Modify: `packages/openclaw-plugin/src/event-classifier.ts`
- Modify: `packages/cli/src/hermes/event-classifier.ts`

The classifier already exists at `packages/openclaw-plugin/src/event-classifier.ts` and is duplicated at `packages/cli/src/hermes/event-classifier.ts`. We promote one canonical copy into core and rewrite both old locations as re-exports so nothing else in the codebase changes.

- [ ] **Step 1: Create the canonical classifier in core**

Create `packages/core/src/runtime/event-classifier.ts` with this content (verbatim copy from `packages/openclaw-plugin/src/event-classifier.ts`):

```ts
export interface TapEmitEventPayload {
	direction: string;
	from: number;
	fromName?: string;
	method: string;
	id: string | number;
	receipt_status: string;
	messageText?: string;
	autoGenerated?: boolean;
	[key: string]: unknown;
}

export type TapEventBucket = "auto-handle" | "escalate" | "notify";

export function classifyTapEvent(event: TapEmitEventPayload): TapEventBucket | null {
	if (event.direction !== "incoming") return null;
	if (event.receipt_status === "duplicate") return null;

	switch (event.method) {
		case "message/send":
		case "action/result":
		case "permissions/update":
			return "auto-handle";

		case "connection/request":
			// Auto-accepted by the service (spec §1.5); the host is notified via the
			// onConnectionEstablished hook instead. Suppress the emitEvent duplicate.
			return null;

		case "action/request":
			// receipt_status "received" = permission grant request (handled synchronously)
			// Transfer requests (receipt_status "queued") are NOT classified here because
			// the approveTransfer hook fires BEFORE emitEvent in the core runtime's
			// async task flow. The hook owns the notification lifecycle for transfers.
			// Scheduling requests (receipt_status "queued") are handled by the
			// approveScheduling hook, which owns the notification lifecycle.
			return event.receipt_status === "received" ? "auto-handle" : null;

		case "connection/result":
			return "notify";

		case "scheduling/propose":
		case "scheduling/counter":
		case "scheduling/accept":
		case "scheduling/cancel":
			return "escalate";

		case "scheduling/reject":
			return "auto-handle";

		default:
			return null;
	}
}
```

- [ ] **Step 2: Add classifier exports to core's runtime index**

Edit `packages/core/src/runtime/index.ts`. Append before the final closing of any block:

```ts
export {
	classifyTapEvent,
	type TapEmitEventPayload,
	type TapEventBucket,
} from "./event-classifier.js";
```

- [ ] **Step 3: Write the failing classifier test in core**

Create `packages/core/test/unit/runtime/event-classifier.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyTapEvent, type TapEmitEventPayload } from "../../../src/runtime/event-classifier.js";

function makeEvent(overrides: Partial<TapEmitEventPayload> = {}): TapEmitEventPayload {
	return {
		direction: "incoming",
		from: 42,
		method: "message/send",
		id: "req-1",
		receipt_status: "delivered",
		...overrides,
	};
}

describe("classifyTapEvent", () => {
	it("returns null for outgoing events", () => {
		expect(classifyTapEvent(makeEvent({ direction: "outgoing" }))).toBeNull();
	});

	it("returns null for duplicate events", () => {
		expect(classifyTapEvent(makeEvent({ receipt_status: "duplicate" }))).toBeNull();
	});

	it("returns auto-handle for message/send, action/result, permissions/update", () => {
		expect(classifyTapEvent(makeEvent({ method: "message/send" }))).toBe("auto-handle");
		expect(classifyTapEvent(makeEvent({ method: "action/result" }))).toBe("auto-handle");
		expect(classifyTapEvent(makeEvent({ method: "permissions/update" }))).toBe("auto-handle");
	});

	it("returns null for connection/request (auto-accepted)", () => {
		expect(classifyTapEvent(makeEvent({ method: "connection/request" }))).toBeNull();
	});

	it("returns notify for connection/result", () => {
		expect(classifyTapEvent(makeEvent({ method: "connection/result" }))).toBe("notify");
	});

	it("returns auto-handle for action/request with receipt_status received", () => {
		expect(
			classifyTapEvent(makeEvent({ method: "action/request", receipt_status: "received" })),
		).toBe("auto-handle");
	});

	it("returns null for action/request with receipt_status queued (handled by hooks)", () => {
		expect(
			classifyTapEvent(makeEvent({ method: "action/request", receipt_status: "queued" })),
		).toBeNull();
	});

	it("returns escalate for scheduling/propose, counter, accept, cancel", () => {
		expect(classifyTapEvent(makeEvent({ method: "scheduling/propose" }))).toBe("escalate");
		expect(classifyTapEvent(makeEvent({ method: "scheduling/counter" }))).toBe("escalate");
		expect(classifyTapEvent(makeEvent({ method: "scheduling/accept" }))).toBe("escalate");
		expect(classifyTapEvent(makeEvent({ method: "scheduling/cancel" }))).toBe("escalate");
	});

	it("returns auto-handle for scheduling/reject", () => {
		expect(classifyTapEvent(makeEvent({ method: "scheduling/reject" }))).toBe("auto-handle");
	});

	it("returns null for unknown methods", () => {
		expect(classifyTapEvent(makeEvent({ method: "unknown/method" }))).toBeNull();
	});
});
```

- [ ] **Step 4: Run the test**

Run: `bun run --cwd packages/core test test/unit/runtime/event-classifier.test.ts`
Expected: all 10 cases PASS.

- [ ] **Step 5: Rewrite openclaw-plugin event-classifier as a re-export**

Replace the entire content of `packages/openclaw-plugin/src/event-classifier.ts` with:

```ts
export {
	classifyTapEvent,
	type TapEmitEventPayload,
	type TapEventBucket,
} from "trusted-agents-core";
```

- [ ] **Step 6: Rewrite hermes event-classifier as a re-export**

Replace the entire content of `packages/cli/src/hermes/event-classifier.ts` with:

```ts
export {
	classifyTapEvent,
	type TapEmitEventPayload,
	type TapEventBucket,
} from "trusted-agents-core";
```

- [ ] **Step 7: Build core and run all tests**

Run: `bun run --cwd packages/core build && bun run test`
Expected: all packages typecheck and all tests pass.

- [ ] **Step 8: Run lint**

Run: `bun run lint`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runtime/event-classifier.ts packages/core/src/runtime/index.ts packages/core/test/unit/runtime/event-classifier.test.ts packages/openclaw-plugin/src/event-classifier.ts packages/cli/src/hermes/event-classifier.ts
git commit -m "refactor(core): move event-classifier from openclaw-plugin into core"
```

---

## Task 3: Add typed event payload to core

**Files:**
- Create: `packages/core/src/runtime/event-types.ts`
- Modify: `packages/core/src/runtime/index.ts`

This task introduces a typed discriminated union representing the events that `TapMessagingService.emitEvent` produces. We do NOT change `service.ts` to enforce the type — the runtime keeps emitting `Record<string, unknown>` for backward compatibility. The new types are consumed by tapd's event bus to translate raw payloads into typed bus events.

- [ ] **Step 1: Create `packages/core/src/runtime/event-types.ts`**

```ts
/**
 * Typed event union representing the discrete things `TapMessagingService.emitEvent`
 * can produce. Consumers (tapd, host plugins) translate the raw `Record<string, unknown>`
 * payload from `emitEvent` into one of these typed shapes.
 *
 * The runtime itself still emits `Record<string, unknown>` to preserve backward
 * compatibility with existing consumers; this file is the canonical schema.
 */

export interface TapEventEnvelope {
	id: string;
	occurredAt: string;
	identityAgentId: number;
}

export interface TapPeerRef {
	connectionId: string;
	peerAgentId: number;
	peerName: string;
	peerChain: string;
}

export interface MessageReceivedEvent extends TapEventEnvelope {
	type: "message.received";
	conversationId: string;
	peer: TapPeerRef;
	messageId: string;
	text: string;
	scope: string;
}

export interface MessageSentEvent extends TapEventEnvelope {
	type: "message.sent";
	conversationId: string;
	peer: TapPeerRef;
	messageId: string;
	text: string;
	scope: string;
}

export type TapActionKind = "transfer" | "scheduling" | "grant";

export interface ActionRequestedEvent extends TapEventEnvelope {
	type: "action.requested";
	conversationId: string;
	peer: TapPeerRef;
	requestId: string;
	kind: TapActionKind;
	payload: Record<string, unknown>;
	direction: "inbound" | "outbound";
}

export interface ActionCompletedEvent extends TapEventEnvelope {
	type: "action.completed";
	conversationId: string;
	requestId: string;
	kind: TapActionKind;
	result: Record<string, unknown>;
	txHash?: string;
	completedAt: string;
}

export interface ActionFailedEvent extends TapEventEnvelope {
	type: "action.failed";
	conversationId: string;
	requestId: string;
	kind: TapActionKind;
	error: string;
}

export interface ActionPendingEvent extends TapEventEnvelope {
	type: "action.pending";
	conversationId: string;
	requestId: string;
	kind: TapActionKind;
	payload: Record<string, unknown>;
	awaitingDecision: true;
}

export interface PendingResolvedEvent extends TapEventEnvelope {
	type: "pending.resolved";
	requestId: string;
	decision: "approved" | "denied";
	decidedBy: "operator" | "auto-grant";
}

export interface ConnectionRequestedEvent extends TapEventEnvelope {
	type: "connection.requested";
	requestId: string;
	peerAgentId: number;
	peerChain: string;
	direction: "inbound" | "outbound";
}

export interface ConnectionEstablishedEvent extends TapEventEnvelope {
	type: "connection.established";
	connectionId: string;
	peer: TapPeerRef;
}

export interface ConnectionFailedEvent extends TapEventEnvelope {
	type: "connection.failed";
	requestId: string;
	error: string;
}

export interface ContactUpdatedEvent extends TapEventEnvelope {
	type: "contact.updated";
	connectionId: string;
	status: string;
	fields: Record<string, unknown>;
}

export interface DaemonStatusEvent extends TapEventEnvelope {
	type: "daemon.status";
	transportConnected: boolean;
	lastSyncAt?: string;
}

export type TapEvent =
	| MessageReceivedEvent
	| MessageSentEvent
	| ActionRequestedEvent
	| ActionCompletedEvent
	| ActionFailedEvent
	| ActionPendingEvent
	| PendingResolvedEvent
	| ConnectionRequestedEvent
	| ConnectionEstablishedEvent
	| ConnectionFailedEvent
	| ContactUpdatedEvent
	| DaemonStatusEvent;

export type TapEventType = TapEvent["type"];
```

- [ ] **Step 2: Export the new types from core**

Edit `packages/core/src/runtime/index.ts`. Append to the existing exports:

```ts
export type {
	ActionCompletedEvent,
	ActionFailedEvent,
	ActionPendingEvent,
	ActionRequestedEvent,
	ConnectionEstablishedEvent,
	ConnectionFailedEvent,
	ConnectionRequestedEvent,
	ContactUpdatedEvent,
	DaemonStatusEvent,
	MessageReceivedEvent,
	MessageSentEvent,
	PendingResolvedEvent,
	TapActionKind,
	TapEvent,
	TapEventEnvelope,
	TapEventType,
	TapPeerRef,
} from "./event-types.js";
```

- [ ] **Step 3: Verify typecheck and tests**

Run: `bun run typecheck && bun run test`
Expected: clean across all packages.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runtime/event-types.ts packages/core/src/runtime/index.ts
git commit -m "feat(core): add typed TapEvent discriminated union"
```

---

## Task 4: Event bus with bounded ring buffer

**Files:**
- Create: `packages/tapd/src/event-bus.ts`
- Create: `packages/tapd/test/unit/event-bus.test.ts`

The event bus is the spine of tapd's notification mechanism. It accepts published events, fans them out to live subscribers, and persists the last N events in a ring buffer so SSE clients reconnecting with `Last-Event-ID` get replay.

- [ ] **Step 1: Write the failing event-bus test**

Create `packages/tapd/test/unit/event-bus.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";
import type { TapEvent } from "trusted-agents-core";

function makeEvent(seq: number): TapEvent {
	return {
		id: `evt-${seq}`,
		type: "daemon.status",
		occurredAt: new Date().toISOString(),
		identityAgentId: 1,
		transportConnected: true,
	};
}

describe("EventBus", () => {
	it("delivers published events to live subscribers", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		const handler = vi.fn();
		bus.subscribe(handler);

		const event = makeEvent(1);
		bus.publish(event);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(event);
	});

	it("does not deliver to handlers added after publish", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		bus.publish(makeEvent(1));

		const handler = vi.fn();
		bus.subscribe(handler);

		expect(handler).not.toHaveBeenCalled();
	});

	it("returns an unsubscribe function that stops delivery", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		const handler = vi.fn();
		const unsubscribe = bus.subscribe(handler);
		unsubscribe();
		bus.publish(makeEvent(1));
		expect(handler).not.toHaveBeenCalled();
	});

	it("retains events in a ring buffer up to its capacity", () => {
		const bus = new EventBus({ ringBufferSize: 3 });
		bus.publish(makeEvent(1));
		bus.publish(makeEvent(2));
		bus.publish(makeEvent(3));
		bus.publish(makeEvent(4));

		expect(bus.snapshot().map((e) => e.id)).toEqual(["evt-2", "evt-3", "evt-4"]);
	});

	it("replays events after a given event id", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		bus.publish(makeEvent(1));
		bus.publish(makeEvent(2));
		bus.publish(makeEvent(3));

		expect(bus.replayAfter("evt-1").map((e) => e.id)).toEqual(["evt-2", "evt-3"]);
	});

	it("replays everything when last event id is unknown", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		bus.publish(makeEvent(1));
		bus.publish(makeEvent(2));

		expect(bus.replayAfter("evt-unknown").map((e) => e.id)).toEqual(["evt-1", "evt-2"]);
	});

	it("returns empty replay when no events published", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		expect(bus.replayAfter(undefined).map((e) => e.id)).toEqual([]);
	});

	it("isolates errors thrown by one handler from other handlers", () => {
		const bus = new EventBus({ ringBufferSize: 10 });
		const failing = vi.fn(() => {
			throw new Error("boom");
		});
		const ok = vi.fn();
		bus.subscribe(failing);
		bus.subscribe(ok);

		bus.publish(makeEvent(1));

		expect(failing).toHaveBeenCalledTimes(1);
		expect(ok).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/tapd test`
Expected: FAIL with "Cannot find module ../../src/event-bus.js" or similar.

- [ ] **Step 3: Implement the event bus**

Create `packages/tapd/src/event-bus.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd packages/tapd test`
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/src/event-bus.ts packages/tapd/test/unit/event-bus.test.ts
git commit -m "feat(tapd): add in-memory event bus with bounded ring buffer"
```

---

## Task 5: Auth token persistence

**Files:**
- Create: `packages/tapd/src/auth-token.ts`
- Create: `packages/tapd/test/unit/auth-token.test.ts`

Bearer-token auth for the localhost TCP transport. Token is generated fresh on each tapd start, persisted to `<dataDir>/.tapd-token` with mode 0600, and validated on every TCP request. Unix socket connections do not require the token (filesystem permissions are auth).

- [ ] **Step 1: Write the failing auth-token test**

Create `packages/tapd/test/unit/auth-token.test.ts`:

```ts
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAuthToken, loadAuthToken, persistAuthToken } from "../../src/auth-token.js";

describe("auth-token", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-auth-test-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	describe("generateAuthToken", () => {
		it("returns a 32-character hex string", () => {
			const token = generateAuthToken();
			expect(token).toMatch(/^[0-9a-f]{32}$/);
		});

		it("returns a different token on each call", () => {
			const a = generateAuthToken();
			const b = generateAuthToken();
			expect(a).not.toEqual(b);
		});
	});

	describe("persistAuthToken", () => {
		it("writes the token to <dataDir>/.tapd-token with mode 0600", async () => {
			const token = "abcdef0123456789abcdef0123456789";
			await persistAuthToken(dataDir, token);

			const tokenPath = join(dataDir, ".tapd-token");
			const contents = await readFile(tokenPath, "utf-8");
			expect(contents).toBe(token);

			const stats = await stat(tokenPath);
			expect(stats.mode & 0o777).toBe(0o600);
		});

		it("overwrites an existing token file", async () => {
			await persistAuthToken(dataDir, "old-token-padding-padding-padding");
			await persistAuthToken(dataDir, "new-token-padding-padding-padding");

			const contents = await readFile(join(dataDir, ".tapd-token"), "utf-8");
			expect(contents).toBe("new-token-padding-padding-padding");
		});
	});

	describe("loadAuthToken", () => {
		it("returns the persisted token", async () => {
			const token = "loaded-token-padding-padding-pad";
			await persistAuthToken(dataDir, token);
			expect(await loadAuthToken(dataDir)).toBe(token);
		});

		it("returns null when no token file exists", async () => {
			expect(await loadAuthToken(dataDir)).toBeNull();
		});
	});
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `bun run --cwd packages/tapd test test/unit/auth-token.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement auth-token**

Create `packages/tapd/src/auth-token.ts`:

```ts
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_FILE = ".tapd-token";

export function generateAuthToken(): string {
	return randomBytes(16).toString("hex");
}

export async function persistAuthToken(dataDir: string, token: string): Promise<void> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, TOKEN_FILE);
	await writeFile(path, token, { encoding: "utf-8", mode: 0o600 });
}

export async function loadAuthToken(dataDir: string): Promise<string | null> {
	try {
		const contents = await readFile(join(dataDir, TOKEN_FILE), "utf-8");
		return contents.trim() || null;
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}

export function tokenFilePath(dataDir: string): string {
	return join(dataDir, TOKEN_FILE);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun run --cwd packages/tapd test test/unit/auth-token.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/src/auth-token.ts packages/tapd/test/unit/auth-token.test.ts
git commit -m "feat(tapd): add bearer auth token generation and persistence"
```

---

## Task 6: Loopback transport test helper

**Files:**
- Create: `packages/tapd/test/helpers/loopback-transport.ts`

A minimal `TransportProvider` implementation that does not require XMTP. Used by every subsequent test that needs to spin up a `TapMessagingService`. We do NOT import the existing helper from `packages/cli/test/helpers/loopback-runtime.ts` because cross-package test imports are fragile; this is a focused, ~80-line helper specific to tapd's needs.

- [ ] **Step 1: Create the loopback transport helper**

Create `packages/tapd/test/helpers/loopback-transport.ts`:

```ts
import type {
	ProtocolMessage,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "trusted-agents-core";

interface PendingDelivery {
	to: number;
	from: number;
	message: ProtocolMessage;
}

/**
 * Minimal in-memory TransportProvider for tapd unit/integration tests.
 *
 * Two LoopbackTransport instances connected to the same `LoopbackNetwork`
 * deliver messages to each other synchronously through the network's queue.
 * The transport never touches XMTP, the filesystem, or the network — every
 * test runs against this in-memory loop.
 */
export class LoopbackNetwork {
	private readonly transports = new Map<number, LoopbackTransport>();

	register(agentId: number, transport: LoopbackTransport): void {
		this.transports.set(agentId, transport);
	}

	unregister(agentId: number): void {
		this.transports.delete(agentId);
	}

	deliver(envelope: PendingDelivery): TransportReceipt {
		const target = this.transports.get(envelope.to);
		if (!target) {
			return { status: "no-route" };
		}
		return target.receive(envelope.from, envelope.message);
	}
}

export class LoopbackTransport implements TransportProvider {
	private handlers: TransportHandlers = {};
	private started = false;

	constructor(
		private readonly agentId: number,
		private readonly network: LoopbackNetwork,
	) {}

	async start(): Promise<void> {
		if (this.started) return;
		this.network.register(this.agentId, this);
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.network.unregister(this.agentId);
		this.started = false;
	}

	setHandlers(handlers: TransportHandlers): void {
		this.handlers = handlers;
	}

	async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
		return this.network.deliver({ to: peerId, from: this.agentId, message });
	}

	async isReachable(_peerId: number): Promise<boolean> {
		return true;
	}

	receive(from: number, message: ProtocolMessage): TransportReceipt {
		const isRequest = message.method !== undefined && "params" in message;
		if (isRequest && this.handlers.onRequest) {
			void this.handlers.onRequest({ from, message });
			return { status: "delivered" };
		}
		if (!isRequest && this.handlers.onResult) {
			void this.handlers.onResult({ from, message });
			return { status: "delivered" };
		}
		return { status: "no-handler" };
	}
}
```

- [ ] **Step 2: Verify it compiles via test typecheck**

Run: `bun run --cwd packages/tapd test`
Expected: existing tests still pass; the new helper compiles (no test references it yet).

- [ ] **Step 3: Commit**

```bash
git add packages/tapd/test/helpers/loopback-transport.ts
git commit -m "test(tapd): add loopback transport helper"
```

---

## Task 7: tapd configuration loading

**Files:**
- Create: `packages/tapd/src/config.ts`
- Create: `packages/tapd/test/unit/config.test.ts`

tapd needs to know which data dir to operate on, what TCP port to bind, and what socket path to use. Config comes from environment variables and explicit constructor options — no file format of its own. The trusted-agents config (`<dataDir>/config.yaml`) is loaded separately by the runtime when constructing the underlying `TapMessagingService`.

- [ ] **Step 1: Write the failing config test**

Create `packages/tapd/test/unit/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveTapdConfig } from "../../src/config.js";

describe("resolveTapdConfig", () => {
	it("uses defaults when no env or options provided", () => {
		const config = resolveTapdConfig({}, {});
		expect(config.dataDir).toMatch(/\.trustedagents$/);
		expect(config.tcpPort).toBe(6810);
		expect(config.tcpHost).toBe("127.0.0.1");
		expect(config.socketPath.endsWith("/.tapd.sock")).toBe(true);
		expect(config.ringBufferSize).toBe(1000);
	});

	it("resolves dataDir from TAP_DATA_DIR env", () => {
		const config = resolveTapdConfig({ TAP_DATA_DIR: "/tmp/foo" }, {});
		expect(config.dataDir).toBe("/tmp/foo");
	});

	it("resolves tcp port from TAPD_PORT env", () => {
		const config = resolveTapdConfig({ TAPD_PORT: "7777" }, {});
		expect(config.tcpPort).toBe(7777);
	});

	it("rejects invalid TAPD_PORT values", () => {
		expect(() => resolveTapdConfig({ TAPD_PORT: "abc" }, {})).toThrow(/TAPD_PORT/);
	});

	it("explicit options override env", () => {
		const config = resolveTapdConfig(
			{ TAP_DATA_DIR: "/tmp/from-env", TAPD_PORT: "7777" },
			{ dataDir: "/tmp/from-options", tcpPort: 8080 },
		);
		expect(config.dataDir).toBe("/tmp/from-options");
		expect(config.tcpPort).toBe(8080);
	});

	it("derives the socket path under the resolved data dir", () => {
		const config = resolveTapdConfig({}, { dataDir: "/tmp/x" });
		expect(config.socketPath).toBe("/tmp/x/.tapd.sock");
	});
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/config.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement config**

Create `packages/tapd/src/config.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export interface TapdConfig {
	dataDir: string;
	socketPath: string;
	tcpHost: string;
	tcpPort: number;
	ringBufferSize: number;
}

export interface TapdConfigOptions {
	dataDir?: string;
	socketPath?: string;
	tcpHost?: string;
	tcpPort?: number;
	ringBufferSize?: number;
}

const DEFAULT_DATA_DIR = join(homedir(), ".trustedagents");
const DEFAULT_TCP_HOST = "127.0.0.1";
const DEFAULT_TCP_PORT = 6810;
const DEFAULT_RING_BUFFER_SIZE = 1000;
const SOCKET_FILE = ".tapd.sock";

export function resolveTapdConfig(
	env: Record<string, string | undefined>,
	options: TapdConfigOptions,
): TapdConfig {
	const dataDir = options.dataDir ?? env.TAP_DATA_DIR ?? DEFAULT_DATA_DIR;
	const tcpHost = options.tcpHost ?? env.TAPD_HOST ?? DEFAULT_TCP_HOST;
	const tcpPort = options.tcpPort ?? parsePort(env.TAPD_PORT) ?? DEFAULT_TCP_PORT;
	const socketPath = options.socketPath ?? join(dataDir, SOCKET_FILE);
	const ringBufferSize = options.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE;

	return { dataDir, socketPath, tcpHost, tcpPort, ringBufferSize };
}

function parsePort(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== value) {
		throw new Error(`TAPD_PORT must be an integer between 1 and 65535, got: ${value}`);
	}
	return parsed;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun run --cwd packages/tapd test test/unit/config.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/src/config.ts packages/tapd/test/unit/config.test.ts
git commit -m "feat(tapd): add config resolution from env and options"
```

---

## Task 8: Runtime wrapper bridging emitEvent → bus

**Files:**
- Create: `packages/tapd/src/runtime.ts`
- Create: `packages/tapd/test/unit/runtime.test.ts`

The runtime layer is what ties a `TapMessagingService` to the `EventBus`. Today, `TapMessagingService.emitEvent` produces `Record<string, unknown>`. tapd subscribes via the `hooks.emitEvent` hook, translates each raw payload into a typed `TapEvent`, and publishes to the bus.

For Phase 1, the runtime wrapper accepts an existing `TapMessagingService` instance constructed by the caller (the daemon) — this keeps the wrapper testable without depending on real config loading. The daemon (Task 16) is responsible for actually building the service.

- [ ] **Step 1: Write the failing runtime test**

Create `packages/tapd/test/unit/runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { TapEvent } from "trusted-agents-core";
import { EventBus } from "../../src/event-bus.js";
import { TapdRuntime } from "../../src/runtime.js";

interface FakeService {
	hooks: { emitEvent?: (payload: Record<string, unknown>) => void };
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
}

function makeService(): FakeService {
	return {
		hooks: {},
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
	};
}

describe("TapdRuntime", () => {
	it("starts the underlying service on start()", async () => {
		const service = makeService();
		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus: new EventBus({ ringBufferSize: 10 }),
		});
		await runtime.start();
		expect(service.start).toHaveBeenCalledTimes(1);
	});

	it("stops the underlying service on stop()", async () => {
		const service = makeService();
		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus: new EventBus({ ringBufferSize: 10 }),
		});
		await runtime.start();
		await runtime.stop();
		expect(service.stop).toHaveBeenCalledTimes(1);
	});

	it("translates raw emitEvent payloads into typed bus events", async () => {
		const service = makeService();
		const bus = new EventBus({ ringBufferSize: 10 });
		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus,
		});
		await runtime.start();

		const captured: TapEvent[] = [];
		bus.subscribe((event) => {
			captured.push(event);
		});

		// Simulate the service emitting a raw payload through its hook.
		service.hooks.emitEvent?.({
			direction: "incoming",
			from: 99,
			method: "message/send",
			id: "req-1",
			receipt_status: "delivered",
			messageText: "hello",
			conversationId: "conv-1",
			peerName: "Bob",
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].type).toBe("message.received");
		expect(captured[0].identityAgentId).toBe(42);
		if (captured[0].type === "message.received") {
			expect(captured[0].text).toBe("hello");
			expect(captured[0].peer.peerAgentId).toBe(99);
		}
	});

	it("emits action.requested for outbound action requests", async () => {
		const service = makeService();
		const bus = new EventBus({ ringBufferSize: 10 });
		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus,
		});
		await runtime.start();

		const captured: TapEvent[] = [];
		bus.subscribe((event) => {
			captured.push(event);
		});

		service.hooks.emitEvent?.({
			direction: "outgoing",
			from: 42,
			to: 99,
			method: "action/request",
			id: "req-2",
			receipt_status: "queued",
			actionKind: "transfer",
			conversationId: "conv-1",
			peerName: "Bob",
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].type).toBe("action.requested");
		if (captured[0].type === "action.requested") {
			expect(captured[0].direction).toBe("outbound");
			expect(captured[0].kind).toBe("transfer");
		}
	});

	it("ignores unknown raw payloads silently", async () => {
		const service = makeService();
		const bus = new EventBus({ ringBufferSize: 10 });
		const runtime = new TapdRuntime({
			service: service as never,
			identityAgentId: 42,
			bus,
		});
		await runtime.start();

		const captured: TapEvent[] = [];
		bus.subscribe((event) => {
			captured.push(event);
		});

		service.hooks.emitEvent?.({
			direction: "weird",
			from: 99,
			method: "totally/unknown",
			id: "x",
			receipt_status: "?",
		});

		expect(captured).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `bun run --cwd packages/tapd test test/unit/runtime.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the runtime wrapper**

Create `packages/tapd/src/runtime.ts`:

```ts
import { randomUUID } from "node:crypto";
import type {
	TapEvent,
	TapMessagingService,
	TapPeerRef,
} from "trusted-agents-core";
import type { EventBus } from "./event-bus.js";

export interface TapdRuntimeOptions {
	service: TapMessagingService;
	identityAgentId: number;
	bus: EventBus;
}

export class TapdRuntime {
	private readonly service: TapMessagingService;
	private readonly identityAgentId: number;
	private readonly bus: EventBus;
	private started = false;

	constructor(options: TapdRuntimeOptions) {
		this.service = options.service;
		this.identityAgentId = options.identityAgentId;
		this.bus = options.bus;
	}

	get tapMessagingService(): TapMessagingService {
		return this.service;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.installEventBridge();
		await this.service.start();
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		await this.service.stop();
		this.started = false;
	}

	private installEventBridge(): void {
		// `TapMessagingService` exposes hooks via its constructor-time options.
		// Here we attach an emitEvent hook that translates raw payloads into
		// typed TapEvents and publishes them to the bus. We mutate the service's
		// hooks object directly because that's how the runtime layer is wired
		// today — see packages/core/src/runtime/service.ts:1923.
		const serviceWithHooks = this.service as unknown as {
			hooks: { emitEvent?: (payload: Record<string, unknown>) => void };
		};
		const previous = serviceWithHooks.hooks.emitEvent;
		serviceWithHooks.hooks.emitEvent = (payload) => {
			previous?.(payload);
			const event = this.translate(payload);
			if (event) {
				this.bus.publish(event);
			}
		};
	}

	private translate(payload: Record<string, unknown>): TapEvent | null {
		const direction = stringField(payload.direction);
		const method = stringField(payload.method);
		if (!method) return null;

		const envelope = {
			id: `evt-${randomUUID()}`,
			occurredAt: new Date().toISOString(),
			identityAgentId: this.identityAgentId,
		};

		const peer = this.peerFromPayload(payload);

		switch (method) {
			case "message/send": {
				const text = stringField(payload.messageText) ?? "";
				const messageId = stringOrIdField(payload.id) ?? "";
				const conversationId = stringField(payload.conversationId) ?? "";
				const scope = stringField(payload.scope) ?? "default";
				if (direction === "incoming") {
					return {
						...envelope,
						type: "message.received",
						conversationId,
						peer,
						messageId,
						text,
						scope,
					};
				}
				if (direction === "outgoing") {
					return {
						...envelope,
						type: "message.sent",
						conversationId,
						peer,
						messageId,
						text,
						scope,
					};
				}
				return null;
			}
			case "action/request": {
				const conversationId = stringField(payload.conversationId) ?? "";
				const kind = parseActionKind(payload.actionKind) ?? "transfer";
				const requestId = stringOrIdField(payload.id) ?? "";
				const reqDirection = direction === "incoming" ? "inbound" : "outbound";
				return {
					...envelope,
					type: "action.requested",
					conversationId,
					peer,
					requestId,
					kind,
					payload,
					direction: reqDirection,
				};
			}
			case "action/result": {
				const conversationId = stringField(payload.conversationId) ?? "";
				const kind = parseActionKind(payload.actionKind) ?? "transfer";
				const requestId = stringOrIdField(payload.id) ?? "";
				const txHash = stringField(payload.txHash);
				return {
					...envelope,
					type: "action.completed",
					conversationId,
					requestId,
					kind,
					result: payload,
					...(txHash ? { txHash } : {}),
					completedAt: envelope.occurredAt,
				};
			}
			case "connection/result": {
				const connectionId = stringField(payload.connectionId) ?? "";
				return {
					...envelope,
					type: "connection.established",
					connectionId,
					peer,
				};
			}
			default:
				return null;
		}
	}

	private peerFromPayload(payload: Record<string, unknown>): TapPeerRef {
		return {
			connectionId: stringField(payload.connectionId) ?? "",
			peerAgentId:
				typeof payload.from === "number"
					? payload.from
					: typeof payload.to === "number"
						? payload.to
						: 0,
			peerName: stringField(payload.peerName) ?? stringField(payload.fromName) ?? "",
			peerChain: stringField(payload.peerChain) ?? "",
		};
	}
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function stringOrIdField(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return undefined;
}

function parseActionKind(value: unknown): "transfer" | "scheduling" | "grant" | undefined {
	if (value === "transfer" || value === "scheduling" || value === "grant") {
		return value;
	}
	return undefined;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun run --cwd packages/tapd test test/unit/runtime.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Run all tapd tests to ensure no regressions**

Run: `bun run --cwd packages/tapd test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tapd/src/runtime.ts packages/tapd/test/unit/runtime.test.ts
git commit -m "feat(tapd): add runtime wrapper bridging emitEvent to event bus"
```

---

## Task 9: HTTP server bones (Unix socket + TCP dual-bind)

**Files:**
- Create: `packages/tapd/src/http/server.ts`
- Create: `packages/tapd/src/http/router.ts`
- Create: `packages/tapd/src/http/response.ts`
- Create: `packages/tapd/src/http/auth.ts`
- Create: `packages/tapd/test/unit/router.test.ts`
- Create: `packages/tapd/test/unit/http-server.test.ts`

The HTTP layer for tapd. We use raw `node:http` (zero-dep) bound to two transports:

1. A **Unix domain socket** at `<dataDir>/.tapd.sock`. Filesystem permissions are auth — no token check.
2. A **localhost TCP port**. Token-gated via `Authorization: Bearer <token>` header.

The same `http.Server` instance handles both. Routes are dispatched by a tiny path-method matcher.

- [ ] **Step 1: Write the failing router test**

Create `packages/tapd/test/unit/router.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Router } from "../../src/http/router.js";

describe("Router", () => {
	it("dispatches GET requests to matching handlers", async () => {
		const router = new Router();
		const handler = vi.fn(async () => ({ ok: true }));
		router.add("GET", "/api/identity", handler);

		const result = await router.dispatch("GET", "/api/identity");
		expect(handler).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true });
	});

	it("returns null when no route matches", async () => {
		const router = new Router();
		expect(await router.dispatch("GET", "/missing")).toBeNull();
	});

	it("matches path parameters and passes them to the handler", async () => {
		const router = new Router();
		const handler = vi.fn(async (params: Record<string, string>) => params);
		router.add("GET", "/api/contacts/:id", handler);

		const result = await router.dispatch("GET", "/api/contacts/abc-123");
		expect(handler).toHaveBeenCalledWith({ id: "abc-123" }, undefined);
		expect(result).toEqual({ id: "abc-123" });
	});

	it("matches multiple path parameters", async () => {
		const router = new Router();
		const handler = vi.fn(async (params: Record<string, string>) => params);
		router.add("GET", "/api/conversations/:id/messages/:msg", handler);

		await router.dispatch("GET", "/api/conversations/c1/messages/m2");
		expect(handler).toHaveBeenCalledWith({ id: "c1", msg: "m2" }, undefined);
	});

	it("differentiates by method", async () => {
		const router = new Router();
		const get = vi.fn(async () => "get");
		const post = vi.fn(async () => "post");
		router.add("GET", "/api/x", get);
		router.add("POST", "/api/x", post);

		expect(await router.dispatch("GET", "/api/x")).toBe("get");
		expect(await router.dispatch("POST", "/api/x")).toBe("post");
	});

	it("ignores trailing slashes", async () => {
		const router = new Router();
		router.add("GET", "/api/x", async () => "ok");
		expect(await router.dispatch("GET", "/api/x/")).toBe("ok");
	});

	it("passes body to handler when provided", async () => {
		const router = new Router();
		const handler = vi.fn(async (params: Record<string, string>, body: unknown) => ({ params, body }));
		router.add("POST", "/api/x", handler);

		const result = await router.dispatch("POST", "/api/x", { hello: "world" });
		expect(result).toEqual({ params: {}, body: { hello: "world" } });
	});
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/router.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the router**

Create `packages/tapd/src/http/router.ts`:

```ts
export type RouteHandler<TBody = unknown, TResult = unknown> = (
	params: Record<string, string>,
	body: TBody,
) => Promise<TResult>;

interface CompiledRoute {
	method: string;
	regex: RegExp;
	paramNames: string[];
	handler: RouteHandler;
}

export class Router {
	private readonly routes: CompiledRoute[] = [];

	add(method: string, pattern: string, handler: RouteHandler): void {
		const { regex, paramNames } = compilePattern(pattern);
		this.routes.push({ method, regex, paramNames, handler });
	}

	async dispatch(method: string, path: string, body?: unknown): Promise<unknown | null> {
		const normalized = stripTrailingSlash(path);
		for (const route of this.routes) {
			if (route.method !== method) continue;
			const match = route.regex.exec(normalized);
			if (!match) continue;
			const params: Record<string, string> = {};
			route.paramNames.forEach((name, i) => {
				params[name] = decodeURIComponent(match[i + 1] ?? "");
			});
			return await route.handler(params, body);
		}
		return null;
	}
}

function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
	const paramNames: string[] = [];
	const regexStr = pattern
		.split("/")
		.map((segment) => {
			if (segment.startsWith(":")) {
				paramNames.push(segment.slice(1));
				return "([^/]+)";
			}
			return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("/");
	return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

function stripTrailingSlash(path: string): string {
	if (path.length > 1 && path.endsWith("/")) {
		return path.slice(0, -1);
	}
	return path;
}
```

- [ ] **Step 4: Run router tests, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/router.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Implement the response helpers**

Create `packages/tapd/src/http/response.ts`:

```ts
import type { ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
	});
	res.end(payload);
}

export function sendError(
	res: ServerResponse,
	status: number,
	code: string,
	message: string,
	details?: Record<string, unknown>,
): void {
	sendJson(res, status, {
		error: {
			code,
			message,
			...(details ? { details } : {}),
		},
	});
}

export function sendNotFound(res: ServerResponse): void {
	sendError(res, 404, "not_found", "no route matches this request");
}

export function sendUnauthorized(res: ServerResponse): void {
	sendError(res, 401, "unauthorized", "missing or invalid bearer token");
}
```

- [ ] **Step 6: Implement the auth middleware**

Create `packages/tapd/src/http/auth.ts`:

```ts
import type { IncomingMessage } from "node:http";

export interface AuthContext {
	/** The transport the client connected through: "unix" requires no token, "tcp" does. */
	transport: "unix" | "tcp";
	expectedToken: string;
}

export function authorizeRequest(req: IncomingMessage, ctx: AuthContext): boolean {
	if (ctx.transport === "unix") {
		return true;
	}
	const header = req.headers.authorization;
	if (!header || typeof header !== "string") {
		return false;
	}
	const match = /^Bearer\s+(.+)$/i.exec(header);
	if (!match) {
		return false;
	}
	return constantTimeEqual(match[1].trim(), ctx.expectedToken);
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i += 1) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}
```

- [ ] **Step 7: Write the failing http-server test**

Create `packages/tapd/test/unit/http-server.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "../../src/http/router.js";
import { TapdHttpServer } from "../../src/http/server.js";

describe("TapdHttpServer", () => {
	let dataDir: string;
	let server: TapdHttpServer | null = null;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-http-test-"));
	});

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = null;
		}
		await rm(dataDir, { recursive: true, force: true });
	});

	it("starts and serves a simple route over TCP with a valid token", async () => {
		const router = new Router();
		router.add("GET", "/api/identity", async () => ({ agentId: 42 }));

		server = new TapdHttpServer({
			router,
			socketPath: join(dataDir, ".tapd.sock"),
			tcpHost: "127.0.0.1",
			tcpPort: 0, // 0 = OS-assigned ephemeral port
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/identity`, {
			headers: { Authorization: "Bearer test-token-test-token-test-token" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ agentId: 42 });
	});

	it("rejects TCP requests without a token", async () => {
		const router = new Router();
		router.add("GET", "/api/identity", async () => ({ agentId: 42 }));

		server = new TapdHttpServer({
			router,
			socketPath: join(dataDir, ".tapd.sock"),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/identity`);
		expect(response.status).toBe(401);
	});

	it("returns 404 for unknown routes", async () => {
		const router = new Router();
		server = new TapdHttpServer({
			router,
			socketPath: join(dataDir, ".tapd.sock"),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/nope`, {
			headers: { Authorization: "Bearer test-token-test-token-test-token" },
		});
		expect(response.status).toBe(404);
	});

	it("parses JSON body for POST requests", async () => {
		const router = new Router();
		router.add("POST", "/api/echo", async (_params, body) => ({ echoed: body }));

		server = new TapdHttpServer({
			router,
			socketPath: join(dataDir, ".tapd.sock"),
			tcpHost: "127.0.0.1",
			tcpPort: 0,
			authToken: "test-token-test-token-test-token",
		});
		await server.start();

		const port = server.boundTcpPort();
		const response = await fetch(`http://127.0.0.1:${port}/api/echo`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token-test-token-test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ hello: "world" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ echoed: { hello: "world" } });
	});
});
```

- [ ] **Step 8: Implement the http server**

Create `packages/tapd/src/http/server.ts`:

```ts
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { authorizeRequest } from "./auth.js";
import { sendError, sendJson, sendNotFound, sendUnauthorized } from "./response.js";
import type { Router } from "./router.js";

export interface TapdHttpServerOptions {
	router: Router;
	socketPath: string;
	tcpHost: string;
	tcpPort: number;
	authToken: string;
	/** Optional hook for SSE upgrade — see Task 14. Returns true if handled. */
	sseHandler?: (req: IncomingMessage, res: ServerResponse, transport: "unix" | "tcp") => boolean;
}

interface BoundServer {
	server: Server;
	transport: "unix" | "tcp";
}

export class TapdHttpServer {
	private readonly router: Router;
	private readonly socketPath: string;
	private readonly tcpHost: string;
	private readonly tcpPort: number;
	private readonly authToken: string;
	private readonly sseHandler?: TapdHttpServerOptions["sseHandler"];

	private bound: BoundServer[] = [];
	private actualTcpPort = 0;

	constructor(options: TapdHttpServerOptions) {
		this.router = options.router;
		this.socketPath = options.socketPath;
		this.tcpHost = options.tcpHost;
		this.tcpPort = options.tcpPort;
		this.authToken = options.authToken;
		this.sseHandler = options.sseHandler;
	}

	async start(): Promise<void> {
		await this.bindUnix();
		await this.bindTcp();
	}

	async stop(): Promise<void> {
		await Promise.all(
			this.bound.map(
				({ server }) =>
					new Promise<void>((resolve) => {
						server.close(() => resolve());
					}),
			),
		);
		this.bound = [];
		await rm(this.socketPath, { force: true }).catch(() => {});
	}

	boundTcpPort(): number {
		return this.actualTcpPort;
	}

	private async bindUnix(): Promise<void> {
		await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
		await rm(this.socketPath, { force: true }).catch(() => {});

		const server = createServer((req, res) => this.handle(req, res, "unix"));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.bound.push({ server, transport: "unix" });
	}

	private async bindTcp(): Promise<void> {
		const server = createServer((req, res) => this.handle(req, res, "tcp"));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.tcpPort, this.tcpHost, () => {
				const address = server.address();
				if (address && typeof address === "object") {
					this.actualTcpPort = address.port;
				}
				server.off("error", reject);
				resolve();
			});
		});
		this.bound.push({ server, transport: "tcp" });
	}

	private handle(
		req: IncomingMessage,
		res: ServerResponse,
		transport: "unix" | "tcp",
	): void {
		void this.handleAsync(req, res, transport).catch((error) => {
			sendError(
				res,
				500,
				"internal_error",
				error instanceof Error ? error.message : "unknown",
			);
		});
	}

	private async handleAsync(
		req: IncomingMessage,
		res: ServerResponse,
		transport: "unix" | "tcp",
	): Promise<void> {
		if (!authorizeRequest(req, { transport, expectedToken: this.authToken })) {
			sendUnauthorized(res);
			return;
		}

		if (this.sseHandler && this.sseHandler(req, res, transport)) {
			return;
		}

		const method = req.method ?? "GET";
		const url = req.url ?? "/";
		const path = url.split("?")[0];

		let body: unknown;
		if (method !== "GET" && method !== "HEAD") {
			body = await readJsonBody(req);
		}

		const result = await this.router.dispatch(method, path, body);
		if (result === null) {
			sendNotFound(res);
			return;
		}
		sendJson(res, 200, result);
	}
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk: string) => {
			raw += chunk;
			if (raw.length > 1024 * 1024) {
				req.destroy();
				reject(new Error("request body too large"));
			}
		});
		req.on("end", () => {
			if (raw.length === 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
```

- [ ] **Step 9: Run http-server tests, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/http-server.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 10: Run all tapd tests**

Run: `bun run --cwd packages/tapd test`
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/tapd/src/http packages/tapd/test/unit/router.test.ts packages/tapd/test/unit/http-server.test.ts
git commit -m "feat(tapd): add HTTP server with router, auth, and dual unix/tcp bind"
```

---

## Task 10: Identity route

**Files:**
- Create: `packages/tapd/src/http/routes/identity.ts`
- Create: `packages/tapd/test/unit/routes/identity.test.ts`

The `GET /api/identity` endpoint returns who tapd is hosting. Used by clients as a probe ("is tapd alive?") and to populate the identity header in the UI.

- [ ] **Step 1: Write the failing identity route test**

Create `packages/tapd/test/unit/routes/identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createIdentityRoute } from "../../../src/http/routes/identity.js";

describe("identity route", () => {
	it("returns identity info from the provided source", async () => {
		const handler = createIdentityRoute(() => ({
			agentId: 42,
			chain: "eip155:8453",
			address: "0xabc",
			displayName: "Alice",
			dataDir: "/tmp/x",
		}));

		const result = await handler({}, undefined);
		expect(result).toEqual({
			agentId: 42,
			chain: "eip155:8453",
			address: "0xabc",
			displayName: "Alice",
			dataDir: "/tmp/x",
		});
	});
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/routes/identity.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement identity route**

Create `packages/tapd/src/http/routes/identity.ts`:

```ts
import type { RouteHandler } from "../router.js";

export interface IdentityInfo {
	agentId: number;
	chain: string;
	address: string;
	displayName: string;
	dataDir: string;
}

export type IdentitySource = () => IdentityInfo;

export function createIdentityRoute(source: IdentitySource): RouteHandler<unknown, IdentityInfo> {
	return async () => source();
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/routes/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/src/http/routes/identity.ts packages/tapd/test/unit/routes/identity.test.ts
git commit -m "feat(tapd): add GET /api/identity route"
```

---

## Task 11: Contacts routes

**Files:**
- Create: `packages/tapd/src/http/routes/contacts.ts`
- Create: `packages/tapd/test/unit/routes/contacts.test.ts`

`GET /api/contacts` lists all contacts. `GET /api/contacts/:connectionId` returns one. Both are thin shims over the existing `ITrustStore` interface from core.

- [ ] **Step 1: Write the failing contacts test**

Create `packages/tapd/test/unit/routes/contacts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEmptyPermissionState } from "trusted-agents-core";
import type { Contact, ITrustStore } from "trusted-agents-core";
import { createContactsRoutes } from "../../../src/http/routes/contacts.js";

function makeContact(overrides: Partial<Contact> = {}): Contact {
	return {
		connectionId: "conn-1",
		peerAgentId: 42,
		peerChain: "eip155:8453",
		peerAgentAddress: "0xabc0000000000000000000000000000000000abc",
		peerOwnerAddress: "0xdef0000000000000000000000000000000000def",
		peerDisplayName: "Alice",
		permissions: createEmptyPermissionState(),
		establishedAt: "2026-04-01T00:00:00.000Z",
		lastContactAt: "2026-04-01T00:00:00.000Z",
		status: "active",
		...overrides,
	};
}

class FakeTrustStore implements Pick<ITrustStore, "getContacts" | "getContact"> {
	constructor(private readonly contacts: Contact[]) {}

	async getContacts(): Promise<Contact[]> {
		return this.contacts;
	}

	async getContact(id: string): Promise<Contact | null> {
		return this.contacts.find((c) => c.connectionId === id) ?? null;
	}
}

describe("contacts routes", () => {
	it("lists all contacts", async () => {
		const store = new FakeTrustStore([
			makeContact({ connectionId: "a" }),
			makeContact({ connectionId: "b" }),
		]);
		const { list } = createContactsRoutes(store as never);

		const result = await list({}, undefined);
		expect(result).toHaveLength(2);
		expect((result as Contact[])[0].connectionId).toBe("a");
	});

	it("returns a single contact by connection id", async () => {
		const store = new FakeTrustStore([makeContact({ connectionId: "a" })]);
		const { get } = createContactsRoutes(store as never);

		const result = await get({ connectionId: "a" }, undefined);
		expect((result as Contact).connectionId).toBe("a");
	});

	it("returns null when contact does not exist", async () => {
		const store = new FakeTrustStore([]);
		const { get } = createContactsRoutes(store as never);

		const result = await get({ connectionId: "missing" }, undefined);
		expect(result).toBeNull();
	});
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/routes/contacts.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement contacts routes**

Create `packages/tapd/src/http/routes/contacts.ts`:

```ts
import type { Contact, ITrustStore } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

export interface ContactsRoutes {
	list: RouteHandler<unknown, Contact[]>;
	get: RouteHandler<unknown, Contact | null>;
}

export function createContactsRoutes(store: ITrustStore): ContactsRoutes {
	return {
		list: async () => await store.getContacts(),
		get: async (params) => {
			const id = params.connectionId;
			if (!id) return null;
			return await store.getContact(id);
		},
	};
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/routes/contacts.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/src/http/routes/contacts.ts packages/tapd/test/unit/routes/contacts.test.ts
git commit -m "feat(tapd): add GET /api/contacts and /api/contacts/:id routes"
```

---

## Task 12: Conversations routes

**Files:**
- Create: `packages/tapd/src/http/routes/conversations.ts`
- Create: `packages/tapd/test/unit/routes/conversations.test.ts`

Three endpoints: list summaries, get full conversation, mark-read. All shims over `IConversationLogger`.

The `mark-read` endpoint is new — it persists a `lastReadAt` timestamp on the conversation log so unread counts in the UI rail decay correctly. We add this as a thin "patch" operation that loads the conversation, sets the field, and saves it back. The schema change (adding `lastReadAt?: string` to `ConversationLog`) is backward-compatible — existing logs without the field default to "all read" or "all unread" depending on UI policy.

- [ ] **Step 1: Add `lastReadAt` field to ConversationLog**

Edit `packages/core/src/conversation/types.ts`. Add the field to the `ConversationLog` interface:

```ts
export interface ConversationLog {
	conversationId: string;
	connectionId: string;
	peerAgentId: number;
	peerDisplayName: string;
	topic?: string;
	startedAt: string;
	lastMessageAt: string;
	lastReadAt?: string;
	status: ConversationStatus;
	messages: ConversationMessage[];
}
```

- [ ] **Step 2: Add `markRead` method to IConversationLogger**

Edit `packages/core/src/conversation/logger.ts`. Add to the `IConversationLogger` interface:

```ts
export interface IConversationLogger {
	logMessage(
		conversationId: string,
		message: ConversationMessage,
		context?: ConversationContext,
	): Promise<void>;
	getConversation(conversationId: string): Promise<ConversationLog | null>;
	listConversations(filter?: { connectionId?: string }): Promise<ConversationLog[]>;
	generateTranscript(conversationId: string): Promise<string>;
	markRead(conversationId: string, readAt: string): Promise<void>;
}
```

Then add the implementation to `FileConversationLogger` (place it after `generateTranscript`):

```ts
async markRead(conversationId: string, readAt: string): Promise<void> {
	await this.writeMutex.runExclusive(async () => {
		const log = await this.loadLog(conversationId);
		if (!log) return;
		log.lastReadAt = readAt;
		await this.saveLog(conversationId, log);
	});
}
```

- [ ] **Step 3: Build core and run all tests**

Run: `bun run --cwd packages/core build && bun run test`
Expected: all PASS. Existing conversation tests should not break because `lastReadAt` is optional and `markRead` is additive.

- [ ] **Step 4: Commit the core changes**

```bash
git add packages/core/src/conversation/types.ts packages/core/src/conversation/logger.ts
git commit -m "feat(core): add lastReadAt field and markRead method to conversation logger"
```

- [ ] **Step 5: Write the failing conversations route test**

Create `packages/tapd/test/unit/routes/conversations.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type {
	ConversationLog,
	IConversationLogger,
} from "trusted-agents-core";
import { createConversationsRoutes } from "../../../src/http/routes/conversations.js";

function makeLog(overrides: Partial<ConversationLog> = {}): ConversationLog {
	return {
		conversationId: "conv-1",
		connectionId: "conn-1",
		peerAgentId: 42,
		peerDisplayName: "Alice",
		startedAt: "2026-04-01T00:00:00.000Z",
		lastMessageAt: "2026-04-02T00:00:00.000Z",
		status: "active",
		messages: [],
		...overrides,
	};
}

class FakeLogger implements IConversationLogger {
	constructor(private readonly logs: ConversationLog[]) {}

	async logMessage(): Promise<void> {}
	async getConversation(id: string): Promise<ConversationLog | null> {
		return this.logs.find((l) => l.conversationId === id) ?? null;
	}
	async listConversations(): Promise<ConversationLog[]> {
		return this.logs;
	}
	async generateTranscript(): Promise<string> {
		return "";
	}
	async markRead(): Promise<void> {}
}

describe("conversations routes", () => {
	it("lists conversations sorted by lastMessageAt desc", async () => {
		const logger = new FakeLogger([
			makeLog({ conversationId: "a", lastMessageAt: "2026-04-01T00:00:00.000Z" }),
			makeLog({ conversationId: "b", lastMessageAt: "2026-04-03T00:00:00.000Z" }),
			makeLog({ conversationId: "c", lastMessageAt: "2026-04-02T00:00:00.000Z" }),
		]);
		const { list } = createConversationsRoutes(logger);

		const result = (await list({}, undefined)) as Array<{ conversationId: string }>;
		expect(result.map((r) => r.conversationId)).toEqual(["b", "c", "a"]);
	});

	it("returns full conversation by id", async () => {
		const logger = new FakeLogger([makeLog({ conversationId: "a" })]);
		const { get } = createConversationsRoutes(logger);

		const result = await get({ id: "a" }, undefined);
		expect((result as ConversationLog).conversationId).toBe("a");
	});

	it("returns null for missing conversation", async () => {
		const logger = new FakeLogger([]);
		const { get } = createConversationsRoutes(logger);

		const result = await get({ id: "missing" }, undefined);
		expect(result).toBeNull();
	});

	it("delegates mark-read to the logger", async () => {
		const logger = new FakeLogger([makeLog({ conversationId: "a" })]);
		const spy = vi.spyOn(logger, "markRead");
		const { markRead } = createConversationsRoutes(logger);

		await markRead({ id: "a" }, undefined);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][0]).toBe("a");
	});
});
```

- [ ] **Step 6: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/routes/conversations.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 7: Implement conversations routes**

Create `packages/tapd/src/http/routes/conversations.ts`:

```ts
import type { ConversationLog, IConversationLogger } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

export interface ConversationsRoutes {
	list: RouteHandler<unknown, ConversationLog[]>;
	get: RouteHandler<unknown, ConversationLog | null>;
	markRead: RouteHandler<unknown, { ok: true }>;
}

export function createConversationsRoutes(logger: IConversationLogger): ConversationsRoutes {
	return {
		list: async () => {
			const all = await logger.listConversations();
			return [...all].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
		},
		get: async (params) => {
			const id = params.id;
			if (!id) return null;
			return await logger.getConversation(id);
		},
		markRead: async (params) => {
			const id = params.id;
			if (id) {
				await logger.markRead(id, new Date().toISOString());
			}
			return { ok: true };
		},
	};
}
```

- [ ] **Step 8: Run tests, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/routes/conversations.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/tapd/src/http/routes/conversations.ts packages/tapd/test/unit/routes/conversations.test.ts
git commit -m "feat(tapd): add conversations routes (list, get, mark-read)"
```

---

## Task 13: Pending routes

**Files:**
- Create: `packages/tapd/src/http/routes/pending.ts`
- Create: `packages/tapd/test/unit/routes/pending.test.ts`

`GET /api/pending` lists items needing operator decision. `POST /api/pending/:id/approve|deny` routes through the existing `TapMessagingService.resolvePending` flow.

For Phase 1 we test the routes against a mocked `TapMessagingService` interface. The actual service has a `pendingRequests` field on its status and a `resolvePending` method.

- [ ] **Step 1: Write the failing pending routes test**

Create `packages/tapd/test/unit/routes/pending.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { TapPendingRequest, TapServiceStatus } from "trusted-agents-core";
import { createPendingRoutes } from "../../../src/http/routes/pending.js";

interface FakeService {
	getStatus: ReturnType<typeof vi.fn>;
	resolvePending: ReturnType<typeof vi.fn>;
}

function makeStatus(pending: TapPendingRequest[] = []): TapServiceStatus {
	return {
		running: true,
		lock: null,
		pendingRequests: pending,
	};
}

function makePendingRequest(overrides: Partial<TapPendingRequest> = {}): TapPendingRequest {
	return {
		requestId: "req-1",
		method: "action/request",
		peerAgentId: 99,
		createdAt: "2026-04-01T00:00:00.000Z",
		...overrides,
	} as TapPendingRequest;
}

function makeService(pending: TapPendingRequest[] = []): FakeService {
	return {
		getStatus: vi.fn(async () => makeStatus(pending)),
		resolvePending: vi.fn(async () => ({ synced: true, processed: 0, pendingRequests: [], pendingDeliveries: [] })),
	};
}

describe("pending routes", () => {
	it("lists pending requests", async () => {
		const service = makeService([
			makePendingRequest({ requestId: "a" }),
			makePendingRequest({ requestId: "b" }),
		]);
		const { list } = createPendingRoutes(service as never);

		const result = (await list({}, undefined)) as TapPendingRequest[];
		expect(result.map((r) => r.requestId)).toEqual(["a", "b"]);
	});

	it("approves a pending request", async () => {
		const service = makeService([makePendingRequest({ requestId: "a" })]);
		const { approve } = createPendingRoutes(service as never);

		await approve({ id: "a" }, { note: "looks good" });
		expect(service.resolvePending).toHaveBeenCalledTimes(1);
		const call = service.resolvePending.mock.calls[0];
		expect(call[0]).toBe("a");
		expect(call[1]).toBe(true);
	});

	it("denies a pending request with a reason", async () => {
		const service = makeService([makePendingRequest({ requestId: "a" })]);
		const { deny } = createPendingRoutes(service as never);

		await deny({ id: "a" }, { reason: "policy" });
		expect(service.resolvePending).toHaveBeenCalledTimes(1);
		const call = service.resolvePending.mock.calls[0];
		expect(call[0]).toBe("a");
		expect(call[1]).toBe(false);
		expect(call[2]).toBe("policy");
	});
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/routes/pending.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement pending routes**

Create `packages/tapd/src/http/routes/pending.ts`:

```ts
import type { TapMessagingService, TapPendingRequest } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

export interface PendingRoutes {
	list: RouteHandler<unknown, TapPendingRequest[]>;
	approve: RouteHandler<{ note?: string }, { resolved: true }>;
	deny: RouteHandler<{ reason?: string }, { resolved: true }>;
}

export function createPendingRoutes(service: TapMessagingService): PendingRoutes {
	return {
		list: async () => {
			const status = await service.getStatus();
			return status.pendingRequests;
		},
		approve: async (params, body) => {
			const id = params.id;
			if (!id) {
				throw new Error("missing pending id");
			}
			await service.resolvePending(id, true, body?.note);
			return { resolved: true };
		},
		deny: async (params, body) => {
			const id = params.id;
			if (!id) {
				throw new Error("missing pending id");
			}
			await service.resolvePending(id, false, body?.reason);
			return { resolved: true };
		},
	};
}
```

- [ ] **Step 4: Run, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/routes/pending.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/src/http/routes/pending.ts packages/tapd/test/unit/routes/pending.test.ts
git commit -m "feat(tapd): add pending routes (list, approve, deny)"
```

---

## Task 14: SSE event stream

**Files:**
- Create: `packages/tapd/src/http/sse.ts`
- Create: `packages/tapd/test/unit/sse.test.ts`

The SSE writer is a small adapter that takes a `node:http` `ServerResponse`, writes the SSE headers, sends events as they arrive on the bus, and supports `Last-Event-ID` replay on connect. Connection cleanup on client disconnect.

- [ ] **Step 1: Write the failing sse test**

Create `packages/tapd/test/unit/sse.test.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { TapEvent } from "trusted-agents-core";
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
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/sse.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the SSE handler**

Create `packages/tapd/src/http/sse.ts`:

```ts
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
	const lastEventId = Array.isArray(lastEventIdHeader)
		? lastEventIdHeader[0]
		: lastEventIdHeader;
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
```

- [ ] **Step 4: Run sse test, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/sse.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/src/http/sse.ts packages/tapd/test/unit/sse.test.ts
git commit -m "feat(tapd): add SSE event stream handler with Last-Event-ID replay"
```

---

## Task 15: Notifications drain endpoint

**Files:**
- Create: `packages/tapd/src/notification-queue.ts`
- Create: `packages/tapd/src/http/routes/notifications.ts`
- Create: `packages/tapd/test/unit/notification-queue.test.ts`
- Create: `packages/tapd/test/unit/routes/notifications.test.ts`

The notifications drain is what host plugins (OpenClaw, Hermes) call from their pre-prompt hooks. tapd holds an in-memory queue that fills as the event bus emits classifiable events, and drains on demand. The shape mirrors what the existing OpenClaw plugin uses today.

- [ ] **Step 1: Write the failing notification queue test**

Create `packages/tapd/test/unit/notification-queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NotificationQueue, type TapNotification } from "../../src/notification-queue.js";

function makeNotification(overrides: Partial<TapNotification> = {}): TapNotification {
	return {
		id: "note-1",
		type: "info",
		oneLiner: "Connection established with Bob",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("NotificationQueue", () => {
	it("starts empty", () => {
		const q = new NotificationQueue();
		expect(q.drain()).toEqual([]);
	});

	it("enqueues and drains notifications", () => {
		const q = new NotificationQueue();
		q.enqueue(makeNotification({ id: "a" }));
		q.enqueue(makeNotification({ id: "b" }));

		const drained = q.drain();
		expect(drained.map((n) => n.id)).toEqual(["a", "b"]);
		expect(q.drain()).toEqual([]);
	});

	it("returns notifications in FIFO order", () => {
		const q = new NotificationQueue();
		for (let i = 0; i < 5; i += 1) {
			q.enqueue(makeNotification({ id: `n-${i}` }));
		}
		const drained = q.drain();
		expect(drained.map((n) => n.id)).toEqual(["n-0", "n-1", "n-2", "n-3", "n-4"]);
	});
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/notification-queue.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the notification queue**

Create `packages/tapd/src/notification-queue.ts`:

```ts
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
```

- [ ] **Step 4: Run notification queue test, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/notification-queue.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Write the failing notifications route test**

Create `packages/tapd/test/unit/routes/notifications.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NotificationQueue } from "../../../src/notification-queue.js";
import { createNotificationsRoute } from "../../../src/http/routes/notifications.js";

describe("notifications route", () => {
	it("returns drained notifications", async () => {
		const q = new NotificationQueue();
		q.enqueue({ id: "a", type: "info", oneLiner: "hello", createdAt: "x" });
		q.enqueue({ id: "b", type: "escalation", oneLiner: "uh oh", createdAt: "y" });
		const handler = createNotificationsRoute(q);

		const result = (await handler({}, undefined)) as { notifications: { id: string }[] };
		expect(result.notifications.map((n) => n.id)).toEqual(["a", "b"]);
		expect(q.size()).toBe(0);
	});

	it("returns empty list when no notifications", async () => {
		const q = new NotificationQueue();
		const handler = createNotificationsRoute(q);
		const result = (await handler({}, undefined)) as { notifications: unknown[] };
		expect(result.notifications).toEqual([]);
	});
});
```

- [ ] **Step 6: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/routes/notifications.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 7: Implement notifications route**

Create `packages/tapd/src/http/routes/notifications.ts`:

```ts
import type { NotificationQueue, TapNotification } from "../../notification-queue.js";
import type { RouteHandler } from "../router.js";

export function createNotificationsRoute(
	queue: NotificationQueue,
): RouteHandler<unknown, { notifications: TapNotification[] }> {
	return async () => ({ notifications: queue.drain() });
}
```

- [ ] **Step 8: Run, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/routes/notifications.test.ts`
Expected: all 2 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/tapd/src/notification-queue.ts packages/tapd/src/http/routes/notifications.ts packages/tapd/test/unit/notification-queue.test.ts packages/tapd/test/unit/routes/notifications.test.ts
git commit -m "feat(tapd): add notification queue and drain route"
```

---

## Task 16: Daemon control endpoints

**Files:**
- Create: `packages/tapd/src/http/routes/daemon-control.ts`
- Create: `packages/tapd/test/unit/routes/daemon-control.test.ts`

`/daemon/health`, `/daemon/sync`, `/daemon/shutdown`. Health is the probe; sync triggers a runtime sync; shutdown triggers a graceful daemon stop via a callback.

- [ ] **Step 1: Write the failing daemon-control test**

Create `packages/tapd/test/unit/routes/daemon-control.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createDaemonControlRoutes } from "../../../src/http/routes/daemon-control.js";

describe("daemon control routes", () => {
	it("returns health information", async () => {
		const { health } = createDaemonControlRoutes({
			version: "0.2.0-beta.6",
			startedAt: Date.now() - 1000,
			isTransportConnected: () => true,
			lastSyncAt: () => "2026-04-01T00:00:00.000Z",
			triggerSync: vi.fn(async () => {}),
			requestShutdown: vi.fn(() => {}),
		});

		const result = (await health({}, undefined)) as {
			status: string;
			version: string;
			uptime: number;
			transportConnected: boolean;
		};
		expect(result.status).toBe("ok");
		expect(result.version).toBe("0.2.0-beta.6");
		expect(result.transportConnected).toBe(true);
		expect(result.uptime).toBeGreaterThanOrEqual(1000);
	});

	it("triggers sync", async () => {
		const triggerSync = vi.fn(async () => {});
		const { sync } = createDaemonControlRoutes({
			version: "0.2.0-beta.6",
			startedAt: Date.now(),
			isTransportConnected: () => true,
			lastSyncAt: () => undefined,
			triggerSync,
			requestShutdown: vi.fn(),
		});

		const result = await sync({}, undefined);
		expect(triggerSync).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true });
	});

	it("requests shutdown", async () => {
		const requestShutdown = vi.fn();
		const { shutdown } = createDaemonControlRoutes({
			version: "0.2.0-beta.6",
			startedAt: Date.now(),
			isTransportConnected: () => true,
			lastSyncAt: () => undefined,
			triggerSync: vi.fn(),
			requestShutdown,
		});

		const result = await shutdown({}, undefined);
		expect(requestShutdown).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true });
	});
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/unit/routes/daemon-control.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement daemon-control routes**

Create `packages/tapd/src/http/routes/daemon-control.ts`:

```ts
import type { RouteHandler } from "../router.js";

export interface DaemonControlOptions {
	version: string;
	startedAt: number;
	isTransportConnected: () => boolean;
	lastSyncAt: () => string | undefined;
	triggerSync: () => Promise<void>;
	requestShutdown: () => void;
}

export interface DaemonControlRoutes {
	health: RouteHandler<unknown, {
		status: "ok";
		version: string;
		uptime: number;
		transportConnected: boolean;
		lastSyncAt?: string;
	}>;
	sync: RouteHandler<unknown, { ok: true }>;
	shutdown: RouteHandler<unknown, { ok: true }>;
}

export function createDaemonControlRoutes(opts: DaemonControlOptions): DaemonControlRoutes {
	return {
		health: async () => {
			const lastSyncAt = opts.lastSyncAt();
			return {
				status: "ok" as const,
				version: opts.version,
				uptime: Date.now() - opts.startedAt,
				transportConnected: opts.isTransportConnected(),
				...(lastSyncAt ? { lastSyncAt } : {}),
			};
		},
		sync: async () => {
			await opts.triggerSync();
			return { ok: true };
		},
		shutdown: async () => {
			opts.requestShutdown();
			return { ok: true };
		},
	};
}
```

- [ ] **Step 4: Run, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/routes/daemon-control.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/src/http/routes/daemon-control.ts packages/tapd/test/unit/routes/daemon-control.test.ts
git commit -m "feat(tapd): add daemon control routes (health, sync, shutdown)"
```

---

## Task 17: Daemon lifecycle

**Files:**
- Create: `packages/tapd/src/daemon.ts`
- Create: `packages/tapd/test/integration/lifecycle.test.ts`

The `Daemon` class wires everything together: configuration, runtime, event bus, notification queue, HTTP server. Owns lifecycle (`start`, `stop`, signal handlers). Uses an injected runtime factory so tests can substitute a fake `TapMessagingService`.

- [ ] **Step 1: Write the failing lifecycle integration test**

Create `packages/tapd/test/integration/lifecycle.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon.js";

interface FakeService {
	hooks: { emitEvent?: (payload: Record<string, unknown>) => void };
	start: () => Promise<void>;
	stop: () => Promise<void>;
	getStatus: () => Promise<{ running: boolean; lock: null; pendingRequests: never[] }>;
	resolvePending: (id: string, approve: boolean, reason?: string) => Promise<unknown>;
	syncOnce: () => Promise<unknown>;
}

function makeFakeService(): FakeService {
	return {
		hooks: {},
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		getStatus: async () => ({ running: true, lock: null, pendingRequests: [] }),
		resolvePending: vi.fn(async () => ({})),
		syncOnce: vi.fn(async () => ({ synced: true, processed: 0, pendingRequests: [], pendingDeliveries: [] })),
	};
}

describe("Daemon lifecycle", () => {
	let dataDir: string;
	let daemon: Daemon | null = null;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-lifecycle-"));
	});

	afterEach(async () => {
		if (daemon) {
			await daemon.stop().catch(() => {});
			daemon = null;
		}
		await rm(dataDir, { recursive: true, force: true });
	});

	it("starts and stops cleanly", async () => {
		const service = makeFakeService();
		daemon = new Daemon({
			config: {
				dataDir,
				socketPath: join(dataDir, ".tapd.sock"),
				tcpHost: "127.0.0.1",
				tcpPort: 0,
				ringBufferSize: 100,
			},
			identityAgentId: 42,
			identitySource: () => ({
				agentId: 42,
				chain: "eip155:8453",
				address: "0xabc",
				displayName: "Alice",
				dataDir,
			}),
			buildService: async () => service as never,
			trustStore: { getContacts: async () => [], getContact: async () => null } as never,
			conversationLogger: {
				logMessage: async () => {},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			} as never,
		});

		await daemon.start();
		expect(service.start).toHaveBeenCalledTimes(1);

		const port = daemon.boundTcpPort();
		const token = daemon.authToken();
		const response = await fetch(`http://127.0.0.1:${port}/api/identity`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ agentId: 42, displayName: "Alice" });

		await daemon.stop();
		expect(service.stop).toHaveBeenCalledTimes(1);
	});

	it("serves /daemon/health over the socket", async () => {
		const service = makeFakeService();
		daemon = new Daemon({
			config: {
				dataDir,
				socketPath: join(dataDir, ".tapd.sock"),
				tcpHost: "127.0.0.1",
				tcpPort: 0,
				ringBufferSize: 100,
			},
			identityAgentId: 42,
			identitySource: () => ({
				agentId: 42,
				chain: "eip155:8453",
				address: "0xabc",
				displayName: "Alice",
				dataDir,
			}),
			buildService: async () => service as never,
			trustStore: { getContacts: async () => [], getContact: async () => null } as never,
			conversationLogger: {
				logMessage: async () => {},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			} as never,
		});

		await daemon.start();
		const port = daemon.boundTcpPort();
		const token = daemon.authToken();
		const response = await fetch(`http://127.0.0.1:${port}/daemon/health`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string; version: string };
		expect(body.status).toBe("ok");
	});
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/tapd test test/integration/lifecycle.test.ts`
Expected: FAIL with module-not-found for `daemon.js`.

- [ ] **Step 3: Implement the Daemon class**

Create `packages/tapd/src/daemon.ts`:

```ts
import type {
	IConversationLogger,
	ITrustStore,
	TapMessagingService,
} from "trusted-agents-core";
import { generateAuthToken, persistAuthToken } from "./auth-token.js";
import type { TapdConfig } from "./config.js";
import { EventBus } from "./event-bus.js";
import { TapdHttpServer } from "./http/server.js";
import { Router } from "./http/router.js";
import { handleSseConnection } from "./http/sse.js";
import { createContactsRoutes } from "./http/routes/contacts.js";
import { createConversationsRoutes } from "./http/routes/conversations.js";
import {
	createDaemonControlRoutes,
	type DaemonControlOptions,
} from "./http/routes/daemon-control.js";
import { type IdentityInfo, type IdentitySource, createIdentityRoute } from "./http/routes/identity.js";
import { createNotificationsRoute } from "./http/routes/notifications.js";
import { createPendingRoutes } from "./http/routes/pending.js";
import { NotificationQueue } from "./notification-queue.js";
import { TapdRuntime } from "./runtime.js";

export const TAPD_VERSION = "0.2.0-beta.6";

export interface DaemonOptions {
	config: TapdConfig;
	identityAgentId: number;
	identitySource: IdentitySource;
	/** Factory that returns the service the daemon should own. */
	buildService: () => Promise<TapMessagingService>;
	trustStore: ITrustStore;
	conversationLogger: IConversationLogger;
}

export class Daemon {
	private readonly options: DaemonOptions;
	private readonly bus: EventBus;
	private readonly notifications: NotificationQueue;
	private runtime: TapdRuntime | null = null;
	private server: TapdHttpServer | null = null;
	private token = "";
	private startedAt = 0;
	private shuttingDown = false;
	private signalHandlersInstalled = false;
	private shutdownResolve: (() => void) | null = null;
	private boundSigInt: (() => void) | null = null;
	private boundSigTerm: (() => void) | null = null;

	constructor(options: DaemonOptions) {
		this.options = options;
		this.bus = new EventBus({ ringBufferSize: options.config.ringBufferSize });
		this.notifications = new NotificationQueue();
	}

	async start(): Promise<void> {
		if (this.runtime) return;

		this.startedAt = Date.now();
		this.token = generateAuthToken();
		await persistAuthToken(this.options.config.dataDir, this.token);

		const service = await this.options.buildService();
		this.runtime = new TapdRuntime({
			service,
			identityAgentId: this.options.identityAgentId,
			bus: this.bus,
		});
		await this.runtime.start();

		const router = this.buildRouter();
		this.server = new TapdHttpServer({
			router,
			socketPath: this.options.config.socketPath,
			tcpHost: this.options.config.tcpHost,
			tcpPort: this.options.config.tcpPort,
			authToken: this.token,
			sseHandler: (req, res, _transport) => {
				if (req.method !== "GET") return false;
				const url = req.url ?? "";
				const path = url.split("?")[0];
				if (path !== "/api/events/stream") return false;
				handleSseConnection(req, res, this.bus);
				return true;
			},
		});
		await this.server.start();
	}

	async stop(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;

		if (this.server) {
			await this.server.stop();
			this.server = null;
		}
		if (this.runtime) {
			await this.runtime.stop();
			this.runtime = null;
		}
		this.removeSignalHandlers();
		if (this.shutdownResolve) {
			const resolve = this.shutdownResolve;
			this.shutdownResolve = null;
			resolve();
		}
	}

	authToken(): string {
		return this.token;
	}

	boundTcpPort(): number {
		return this.server?.boundTcpPort() ?? 0;
	}

	async runUntilSignal(): Promise<void> {
		await this.start();
		this.installSignalHandlers();
		await new Promise<void>((resolve) => {
			this.shutdownResolve = resolve;
		});
	}

	private installSignalHandlers(): void {
		if (this.signalHandlersInstalled) return;
		this.signalHandlersInstalled = true;
		this.boundSigInt = () => {
			void this.stop();
		};
		this.boundSigTerm = () => {
			void this.stop();
		};
		process.on("SIGINT", this.boundSigInt);
		process.on("SIGTERM", this.boundSigTerm);
	}

	private removeSignalHandlers(): void {
		if (!this.signalHandlersInstalled) return;
		if (this.boundSigInt) {
			process.off("SIGINT", this.boundSigInt);
			this.boundSigInt = null;
		}
		if (this.boundSigTerm) {
			process.off("SIGTERM", this.boundSigTerm);
			this.boundSigTerm = null;
		}
		this.signalHandlersInstalled = false;
	}

	private buildRouter(): Router {
		const router = new Router();

		const identityRoute = createIdentityRoute(this.options.identitySource);
		router.add("GET", "/api/identity", identityRoute);

		const contacts = createContactsRoutes(this.options.trustStore);
		router.add("GET", "/api/contacts", contacts.list);
		router.add("GET", "/api/contacts/:connectionId", contacts.get);

		const conversations = createConversationsRoutes(this.options.conversationLogger);
		router.add("GET", "/api/conversations", conversations.list);
		router.add("GET", "/api/conversations/:id", conversations.get);
		router.add("POST", "/api/conversations/:id/mark-read", conversations.markRead);

		const ensureRuntime = (): TapMessagingService => {
			if (!this.runtime) {
				throw new Error("daemon runtime is not running");
			}
			return this.runtime.tapMessagingService;
		};

		// Adapter exposing only the methods the pending routes need. We pass the
		// adapter (typed as `TapMessagingService`) so the routes don't need a
		// reference to the live runtime — they re-resolve it on every call.
		const pendingAdapter = {
			getStatus: () => ensureRuntime().getStatus(),
			resolvePending: (id: string, approve: boolean, reason?: string) =>
				ensureRuntime().resolvePending(id, approve, reason),
		} as unknown as TapMessagingService;
		const pending = createPendingRoutes(pendingAdapter);
		router.add("GET", "/api/pending", pending.list);
		router.add("POST", "/api/pending/:id/approve", pending.approve);
		router.add("POST", "/api/pending/:id/deny", pending.deny);

		const notifications = createNotificationsRoute(this.notifications);
		router.add("GET", "/api/notifications/drain", notifications);

		const controlOptions: DaemonControlOptions = {
			version: TAPD_VERSION,
			startedAt: this.startedAt,
			isTransportConnected: () => this.runtime !== null,
			lastSyncAt: () => undefined,
			triggerSync: async () => {
				const service = ensureRuntime();
				await service.syncOnce();
			},
			requestShutdown: () => {
				void this.stop();
			},
		};
		const control = createDaemonControlRoutes(controlOptions);
		router.add("GET", "/daemon/health", control.health);
		router.add("POST", "/daemon/sync", control.sync);
		router.add("POST", "/daemon/shutdown", control.shutdown);

		return router;
	}
}
```

- [ ] **Step 4: Run lifecycle test, expect pass**

Run: `bun run --cwd packages/tapd test test/integration/lifecycle.test.ts`
Expected: all 2 tests PASS.

- [ ] **Step 5: Run all tapd tests for regression**

Run: `bun run --cwd packages/tapd test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tapd/src/daemon.ts packages/tapd/test/integration/lifecycle.test.ts
git commit -m "feat(tapd): add Daemon class wiring runtime, http, and event bus"
```

---

## Task 18: bin entrypoint

**Files:**
- Create: `packages/tapd/src/bin.ts`
- Modify: `packages/tapd/src/index.ts`

The bin entrypoint loads the trusted-agents config from the data dir, builds the real `TapMessagingService` with the existing `buildDefaultTapRuntimeContext`, constructs the `Daemon`, and runs until SIGINT/SIGTERM.

- [ ] **Step 1: Write `packages/tapd/src/bin.ts`**

```ts
#!/usr/bin/env node
import {
	OwsSigningProvider,
	TapMessagingService,
	buildDefaultTapRuntimeContext,
	loadTrustedAgentConfigFromDataDir,
} from "trusted-agents-core";
import { Daemon, TAPD_VERSION } from "./daemon.js";
import { resolveTapdConfig } from "./config.js";

async function main(): Promise<void> {
	const tapdConfig = resolveTapdConfig(process.env, {});

	process.stdout.write(
		`tapd ${TAPD_VERSION} starting (dataDir=${tapdConfig.dataDir}, port=${tapdConfig.tcpPort})\n`,
	);

	const trustedAgentsConfig = await loadTrustedAgentConfigFromDataDir(tapdConfig.dataDir);
	const signingProvider = new OwsSigningProvider(
		trustedAgentsConfig.ows.wallet,
		trustedAgentsConfig.chain,
		trustedAgentsConfig.ows.apiKey,
	);

	const context = await buildDefaultTapRuntimeContext(trustedAgentsConfig, {
		signingProvider,
	});

	const buildService = async (): Promise<TapMessagingService> => {
		return new TapMessagingService(context, {
			ownerLabel: `tapd:${process.pid}`,
			hooks: {
				log: (level, message) => {
					process.stdout.write(`[tapd:${level}] ${message}\n`);
				},
			},
		});
	};

	const daemon = new Daemon({
		config: tapdConfig,
		identityAgentId: trustedAgentsConfig.agentId,
		identitySource: () => ({
			agentId: trustedAgentsConfig.agentId,
			chain: trustedAgentsConfig.chain,
			address: "",
			displayName: "",
			dataDir: tapdConfig.dataDir,
		}),
		buildService,
		trustStore: context.trustStore,
		conversationLogger: context.conversationLogger,
	});

	try {
		await daemon.runUntilSignal();
		process.stdout.write("tapd shut down cleanly\n");
		process.exit(0);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`tapd failed: ${message}\n`);
		process.exit(1);
	}
}

void main();
```

- [ ] **Step 2: Update `packages/tapd/src/index.ts`**

Replace the current placeholder with full public exports:

```ts
export { Daemon, TAPD_VERSION, type DaemonOptions } from "./daemon.js";
export { resolveTapdConfig, type TapdConfig, type TapdConfigOptions } from "./config.js";
export { EventBus, type EventBusOptions, type EventHandler } from "./event-bus.js";
export { TapdRuntime, type TapdRuntimeOptions } from "./runtime.js";
export {
	NotificationQueue,
	type TapNotification,
	type TapNotificationType,
} from "./notification-queue.js";
export {
	generateAuthToken,
	persistAuthToken,
	loadAuthToken,
	tokenFilePath,
} from "./auth-token.js";
```

- [ ] **Step 3: Verify build**

Run: `bun run --cwd packages/tapd build`
Expected: clean compile, `packages/tapd/dist/bin.js` exists.

- [ ] **Step 4: Verify typecheck of the whole repo**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/src/bin.ts packages/tapd/src/index.ts
git commit -m "feat(tapd): add bin entrypoint and public exports"
```

---

## Task 19: End-to-end HTTP integration test

**Files:**
- Create: `packages/tapd/test/integration/http-end-to-end.test.ts`

Spin up a real `Daemon` with all routes wired and verify the full HTTP surface works against an in-memory `TapMessagingService` driven by the loopback transport. This is the canonical "Phase 1 done" test.

- [ ] **Step 1: Write the integration test**

Create `packages/tapd/test/integration/http-end-to-end.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon.js";

function makeFakeService() {
	return {
		hooks: {} as { emitEvent?: (payload: Record<string, unknown>) => void },
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		getStatus: vi.fn(async () => ({ running: true, lock: null, pendingRequests: [] })),
		resolvePending: vi.fn(async () => ({})),
		syncOnce: vi.fn(async () => ({ synced: true, processed: 0, pendingRequests: [], pendingDeliveries: [] })),
	};
}

describe("tapd HTTP end-to-end", () => {
	let dataDir: string;
	let daemon: Daemon | null = null;
	let port = 0;
	let token = "";

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-e2e-"));
		const service = makeFakeService();
		daemon = new Daemon({
			config: {
				dataDir,
				socketPath: join(dataDir, ".tapd.sock"),
				tcpHost: "127.0.0.1",
				tcpPort: 0,
				ringBufferSize: 100,
			},
			identityAgentId: 42,
			identitySource: () => ({
				agentId: 42,
				chain: "eip155:8453",
				address: "0xabc",
				displayName: "Alice",
				dataDir,
			}),
			buildService: async () => service as never,
			trustStore: { getContacts: async () => [], getContact: async () => null } as never,
			conversationLogger: {
				logMessage: async () => {},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			} as never,
		});
		await daemon.start();
		port = daemon.boundTcpPort();
		token = daemon.authToken();
	});

	afterEach(async () => {
		if (daemon) {
			await daemon.stop().catch(() => {});
			daemon = null;
		}
		await rm(dataDir, { recursive: true, force: true });
	});

	const fetchTapd = (path: string, init?: RequestInit) =>
		fetch(`http://127.0.0.1:${port}${path}`, {
			...init,
			headers: {
				...(init?.headers ?? {}),
				Authorization: `Bearer ${token}`,
			},
		});

	it("GET /api/identity returns the identity", async () => {
		const response = await fetchTapd("/api/identity");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ agentId: 42, displayName: "Alice" });
	});

	it("GET /api/contacts returns an empty list initially", async () => {
		const response = await fetchTapd("/api/contacts");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});

	it("GET /api/conversations returns an empty list initially", async () => {
		const response = await fetchTapd("/api/conversations");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});

	it("GET /api/pending returns an empty list initially", async () => {
		const response = await fetchTapd("/api/pending");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});

	it("GET /api/notifications/drain returns an empty list initially", async () => {
		const response = await fetchTapd("/api/notifications/drain");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ notifications: [] });
	});

	it("GET /daemon/health returns ok", async () => {
		const response = await fetchTapd("/daemon/health");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string; transportConnected: boolean };
		expect(body.status).toBe("ok");
		expect(body.transportConnected).toBe(true);
	});

	it("POST /daemon/sync returns ok", async () => {
		const response = await fetchTapd("/daemon/sync", { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("rejects requests without a bearer token", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/api/identity`);
		expect(response.status).toBe(401);
	});

	it("returns 404 for unknown routes", async () => {
		const response = await fetchTapd("/api/nope");
		expect(response.status).toBe(404);
	});
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun run --cwd packages/tapd test test/integration/http-end-to-end.test.ts`
Expected: all 9 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/tapd/test/integration/http-end-to-end.test.ts
git commit -m "test(tapd): add end-to-end HTTP integration test"
```

---

## Task 20: SSE replay integration test

**Files:**
- Create: `packages/tapd/test/integration/sse-replay.test.ts`

Verifies that an SSE client connecting with `Last-Event-ID` receives all buffered events strictly after that id.

- [ ] **Step 1: Write the SSE replay test**

Create `packages/tapd/test/integration/sse-replay.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TapEvent } from "trusted-agents-core";
import { Daemon } from "../../src/daemon.js";

interface FakeService {
	hooks: { emitEvent?: (payload: Record<string, unknown>) => void };
	start: () => Promise<void>;
	stop: () => Promise<void>;
	getStatus: () => Promise<{ running: boolean; lock: null; pendingRequests: never[] }>;
	resolvePending: (id: string, approve: boolean, reason?: string) => Promise<unknown>;
	syncOnce: () => Promise<unknown>;
}

function makeFakeService(): FakeService {
	return {
		hooks: {},
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		getStatus: async () => ({ running: true, lock: null, pendingRequests: [] }),
		resolvePending: vi.fn(async () => ({})),
		syncOnce: vi.fn(async () => ({})),
	};
}

async function readSseEvents(
	url: string,
	headers: Record<string, string>,
	maxMs: number,
): Promise<TapEvent[]> {
	const response = await fetch(url, { headers });
	if (!response.body) return [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events: TapEvent[] = [];
	let buffer = "";
	const deadline = Date.now() + maxMs;

	while (Date.now() < deadline) {
		const { value, done } = await Promise.race([
			reader.read(),
			new Promise<{ value: undefined; done: true }>((resolve) =>
				setTimeout(() => resolve({ value: undefined, done: true }), 100),
			),
		]);
		if (done) break;
		if (!value) continue;
		buffer += decoder.decode(value, { stream: true });
		while (buffer.includes("\n\n")) {
			const idx = buffer.indexOf("\n\n");
			const block = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
			if (dataLine) {
				try {
					events.push(JSON.parse(dataLine.slice("data: ".length)) as TapEvent);
				} catch {
					/* ignore non-JSON */
				}
			}
		}
	}
	reader.releaseLock();
	return events;
}

describe("tapd SSE replay", () => {
	let dataDir: string;
	let daemon: Daemon | null = null;
	let port = 0;
	let token = "";
	let service: FakeService;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tapd-sse-"));
		service = makeFakeService();
		daemon = new Daemon({
			config: {
				dataDir,
				socketPath: join(dataDir, ".tapd.sock"),
				tcpHost: "127.0.0.1",
				tcpPort: 0,
				ringBufferSize: 100,
			},
			identityAgentId: 42,
			identitySource: () => ({
				agentId: 42,
				chain: "eip155:8453",
				address: "0xabc",
				displayName: "Alice",
				dataDir,
			}),
			buildService: async () => service as never,
			trustStore: { getContacts: async () => [], getContact: async () => null } as never,
			conversationLogger: {
				logMessage: async () => {},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			} as never,
		});
		await daemon.start();
		port = daemon.boundTcpPort();
		token = daemon.authToken();
	});

	afterEach(async () => {
		if (daemon) {
			await daemon.stop().catch(() => {});
			daemon = null;
		}
		await rm(dataDir, { recursive: true, force: true });
	});

	it("delivers events emitted via the underlying service hook", async () => {
		// Emit two raw payloads through the service hook BEFORE the SSE client
		// connects. New clients (no Last-Event-ID) start fresh, so the client
		// must reconnect with the id of the last seen event to get replay.
		service.hooks.emitEvent?.({
			direction: "incoming",
			from: 99,
			method: "message/send",
			id: "wire-1",
			receipt_status: "delivered",
			messageText: "hello",
			conversationId: "conv-1",
		});
		service.hooks.emitEvent?.({
			direction: "incoming",
			from: 99,
			method: "message/send",
			id: "wire-2",
			receipt_status: "delivered",
			messageText: "world",
			conversationId: "conv-1",
		});

		// Connect the SSE client with a non-existent Last-Event-ID — semantics
		// say "client missed everything in the buffer," so all 2 should replay.
		const events = await readSseEvents(
			`http://127.0.0.1:${port}/api/events/stream`,
			{ Authorization: `Bearer ${token}`, "Last-Event-ID": "evt-unknown" },
			500,
		);

		expect(events.length).toBeGreaterThanOrEqual(2);
		const messageEvents = events.filter((e) => e.type === "message.received");
		expect(messageEvents.length).toBe(2);
		expect((messageEvents[0] as { text: string }).text).toBe("hello");
		expect((messageEvents[1] as { text: string }).text).toBe("world");
	});

	it("replays only events strictly after the given Last-Event-ID", async () => {
		service.hooks.emitEvent?.({
			direction: "incoming",
			from: 99,
			method: "message/send",
			id: "wire-1",
			receipt_status: "delivered",
			messageText: "first",
			conversationId: "conv-1",
		});
		service.hooks.emitEvent?.({
			direction: "incoming",
			from: 99,
			method: "message/send",
			id: "wire-2",
			receipt_status: "delivered",
			messageText: "second",
			conversationId: "conv-1",
		});

		// Inspect the bus directly to find the actual generated event id of the first event.
		const firstClientEvents = await readSseEvents(
			`http://127.0.0.1:${port}/api/events/stream`,
			{ Authorization: `Bearer ${token}`, "Last-Event-ID": "evt-unknown" },
			500,
		);
		expect(firstClientEvents.length).toBeGreaterThanOrEqual(2);
		const firstEventId = firstClientEvents[0].id;

		// New connection asking for events strictly after the first — should get only the second.
		const replayed = await readSseEvents(
			`http://127.0.0.1:${port}/api/events/stream`,
			{ Authorization: `Bearer ${token}`, "Last-Event-ID": firstEventId },
			500,
		);
		const messages = replayed.filter((e) => e.type === "message.received");
		expect(messages.length).toBe(1);
		expect((messages[0] as { text: string }).text).toBe("second");
	});
});
```

- [ ] **Step 2: Run the SSE replay test**

Run: `bun run --cwd packages/tapd test test/integration/sse-replay.test.ts`
Expected: both tests PASS.

- [ ] **Step 3: Run the full tapd test suite**

Run: `bun run --cwd packages/tapd test`
Expected: every test PASS.

- [ ] **Step 4: Run repo-wide test suite to check for regressions**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: every test in every package PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapd/test/integration/sse-replay.test.ts
git commit -m "test(tapd): add SSE replay integration test"
```

---

## Phase 1 verification

After all 20 tasks complete, verify the deliverable:

- [ ] **Step 1: Build the tapd binary**

Run: `bun run --cwd packages/tapd build`
Expected: `packages/tapd/dist/bin.js` exists and is executable.

- [ ] **Step 2: Run the full repo test suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all checks pass across all packages.

- [ ] **Step 3: Confirm no regressions in other packages**

Run: `bun run --cwd packages/openclaw-plugin test && bun run --cwd packages/cli test && bun run --cwd packages/core test`
Expected: every existing test passes.

- [ ] **Step 4: Inventory the new package**

Run: `find packages/tapd/src -name "*.ts" -exec wc -l {} \; | sort -n -r`
Expected: no source file exceeds ~250 lines. If any do, that's a signal the file should be split.

- [ ] **Step 5: Final commit if anything is outstanding**

If any cleanups are needed (formatting, missed imports), commit them as a single tidying commit:

```bash
git add -A
git commit -m "chore(tapd): final phase 1 cleanup"
```

**Phase 1 complete.** The `packages/tapd` workspace builds, tests pass, and the daemon binary runs against a configured data dir. Nothing else in the repo references it yet — that's Phase 3's job. The next thing to plan and execute is Phase 2: the Next.js web UI.
