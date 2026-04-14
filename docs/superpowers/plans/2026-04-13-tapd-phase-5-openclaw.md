# tapd Phase 5: OpenClaw Plugin Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or run inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `packages/openclaw-plugin/` from ~1600 lines of TypeScript to ~300 by deleting the per-process `OpenClawTapRegistry`, the local notification queue, the local main-session helper, and the now-redundant event classifier re-export. Rewire `plugin.ts`, `tool.ts`, and `config.ts` so the plugin becomes a thin HTTP client of `tapd` over its `<dataDir>/.tapd.sock` Unix socket. After Phase 5, the OpenClaw plugin no longer constructs any `TapMessagingService` of its own and contains zero TAP protocol logic.

**Architecture:** OpenClaw plugin = thin host adapter. Three responsibilities only:
1. Register the `tap_gateway` tool with the same schema users see today, dispatching each action to a tapd HTTP endpoint over the Unix socket
2. Run a `before_prompt_build` hook that drains notifications from `GET /api/notifications/drain` and prepends `[TAP Notifications]` to the agent's context
3. Wake the agent on escalation events (the existing `requestHeartbeatNow()` + `enqueueSystemEvent()` pipeline) — these stay because they are OpenClaw-specific runtime hooks tapd cannot drive

**Tech stack:** `node:http`, `node:net` for the Unix-socket HTTP client. No new dependencies. Reuses the same patterns from Phase 4's Hermes Python plugin rewrite, but in TypeScript.

**Out of scope for Phase 5:**
- The v2 SQLite migration (next thing after this)
- New tapd routes (Phases 1–4 already added everything the plugin needs)
- Multi-identity workspace selection beyond the existing `identity` parameter
- Removing the `event-classifier.ts` re-export shim (already a one-liner; leave it)

**Note for executors — read this carefully.**

This phase deletes ~1300 lines of working TypeScript. Be careful:
1. Before deleting any file, grep for remaining imports of its exports across the entire repo. If found, those callers must be updated in the same task.
2. The `OpenClawTapRegistry` is the largest single file in the plugin (947 lines). It contains all the per-identity state management, scheduling handler wiring, transfer execution, signing provider setup, periodic reconcile timers, escalation queueing — every piece of logic. Tapd already has all of it. The deletion is consolidation, not regression.
3. The `tool.ts` action-handlers must be rewritten to call tapd HTTP endpoints. The schema (`TapGatewayToolSchema`) MUST NOT change — OpenClaw users have agents that call `tap_gateway` with the existing parameter shape.
4. The `before_prompt_build` hook's contract with OpenClaw is fixed — we keep the `prependContext` shape exactly as today.

**Bearer token note:** The OpenClaw plugin runs in the same Node process as OpenClaw Gateway. It connects to `<dataDir>/.tapd.sock` over a Unix socket, so no bearer token is needed (filesystem permissions are auth). Skip the token plumbing entirely.

**Escalation queue note:** Today, when tapd would emit an "escalation" event (ungrantable transfer, scheduling proposal), the plugin's local notification queue sets a flag and the next OpenClaw prompt cycle drains it. After Phase 5, the plugin needs to **subscribe to tapd's SSE event stream** for escalation events so it can call `requestHeartbeatNow()` immediately rather than waiting for the next agent turn. This is a small but important addition: the SSE subscription lives inside the plugin process, listens for `action.pending` and other escalation event types, and triggers heartbeat wakes. We add this in Task 6.

---

## File map

**Modified in `packages/openclaw-plugin/src/`:**

```
plugin.ts                       # Replace OpenClawTapRegistry construction with TapdHttpClient
tool.ts                         # Each action handler becomes a tapd HTTP call
config.ts                       # Shrink to { tapdSocketPath?, dataDir? } + escalation event types
```

**New files in `packages/openclaw-plugin/src/`:**

```
tapd-client.ts                  # Thin HTTP-over-Unix-socket client (TS twin of the Hermes Python client)
escalation-watcher.ts           # SSE subscription that triggers OpenClaw heartbeats on escalation events
notifications-drain.ts          # Pre-prompt hook helper that calls GET /api/notifications/drain
```

**Deleted from `packages/openclaw-plugin/src/`:**

```
registry.ts                     # OpenClawTapRegistry — 947 lines of per-identity TapMessagingService management
notification-queue.ts           # Local notification queue — tapd owns this now
main-session.ts                 # OpenClaw main-session helper — no longer needed without per-identity state
event-classifier.ts             # The Phase 1 one-line re-export shim. Now also unused — delete.
```

**Modified in `packages/openclaw-plugin/test/`:**

Existing tests for `OpenClawTapRegistry`, `notification-queue`, `event-classifier`, `main-session` are deleted (their behavior is now covered by tapd's own tests). Replace with:
- `tapd-client.test.ts` — exercises the HTTP-over-Unix-socket client against an in-process tapd
- `tool.test.ts` (replaces or extends existing) — verifies each `tap_gateway` action produces the expected HTTP request and returns the tapd response shape
- `escalation-watcher.test.ts` — verifies that an SSE escalation event triggers the OpenClaw heartbeat hook
- `notifications-drain.test.ts` — verifies the pre-prompt hook drains and formats correctly
- `plugin.test.ts` (or similar) — sanity test that `register()` wires everything correctly against a fake `OpenClawPluginApi`

**Workspace root:**

No changes needed. The package's `package.json` may shed the `trusted-agents-sdk` dependency (the plugin no longer constructs a `TapRuntime` directly) but it can stay if other code paths reference it; leaving it pinned is harmless.

---

## Pre-flight: read these files

Before starting, the implementer should read in order:

1. `packages/openclaw-plugin/src/registry.ts` — the 947-line file being deleted. Skim it to understand what scheduling, signing, transfer, reconcile, and escalation logic moved into tapd in earlier phases.
2. `packages/openclaw-plugin/src/plugin.ts` — current 63-line entrypoint. Will become ~80-100 lines after the refactor.
3. `packages/openclaw-plugin/src/tool.ts` — the `tap_gateway` tool definition. The schema stays; the handler bodies change.
4. `packages/openclaw-plugin/src/notification-queue.ts` — the local in-memory queue being deleted. Look at the `TapNotification` shape it produces; that shape is what the drain hook returns from tapd.
5. `packages/openclaw-plugin/src/main-session.ts` — what it does today, why it's no longer needed.
6. `packages/openclaw-plugin/src/config.ts` — current 131-line config. Will shrink to ~30 lines.
7. `packages/cli/assets/hermes/plugin/client.py` — the Hermes Python equivalent of the new tapd client. Same architecture, different language. Use it as a reference.
8. `packages/cli/src/lib/tapd-client.ts` — the existing CLI tapd client. The OpenClaw client is similar but uses Unix socket only (no token), and lives in TypeScript inside the plugin process.
9. `packages/tapd/src/http/routes/` — the endpoints we'll be calling. Confirm shapes.
10. `packages/cli/test/helpers/in-process-tapd.ts` — pattern for tests that need a real tapd.

---

## Action → tapd endpoint mapping table

Every `tap_gateway` action maps to a tapd HTTP endpoint:

| Action | HTTP method | tapd endpoint |
|---|---|---|
| `status` | GET | `/daemon/health` (merge with `/api/identity` if needed for the response shape) |
| `sync` | POST | `/daemon/sync` |
| `restart` | POST | `/daemon/shutdown` (then return ok; daemon manager auto-restarts) |
| `create_invite` | POST | `/api/invites` |
| `connect` | POST | `/api/connect` |
| `send_message` | POST | `/api/messages` |
| `publish_grants` | POST | `/api/grants/publish` |
| `request_grants` | POST | `/api/grants/request` |
| `request_funds` | POST | `/api/funds-requests` |
| `transfer` | POST | `/api/transfers` |
| `request_meeting` | POST | `/api/meetings` |
| `respond_meeting` | POST | `/api/meetings/:scheduling_id/respond` |
| `cancel_meeting` | POST | `/api/meetings/:scheduling_id/cancel` |
| `list_pending` | GET | `/api/pending` |
| `resolve_pending` | POST | `/api/pending/:request_id/{approve,deny}` |

(Notification drain is its own thing, called from the pre-prompt hook, not from `tap_gateway`.)

---

## Task 1: Add `tapd-client.ts` to the OpenClaw plugin

**Files:**
- Create: `packages/openclaw-plugin/src/tapd-client.ts`
- Create: `packages/openclaw-plugin/test/tapd-client.test.ts`

A thin TypeScript HTTP-over-Unix-socket client. Mirrors the Hermes Python `client.py` from Phase 4 but in TS.

- [ ] **Step 1: Read the Hermes Python client for the architecture**

`packages/cli/assets/hermes/plugin/client.py` — the new Phase 4 version. Note the discovery, the request flow, the error handling. Translate the same patterns to TS.

- [ ] **Step 2: Write the failing test**

Create `packages/openclaw-plugin/test/tapd-client.test.ts`. Use vitest. Test against an in-process tapd by importing the existing helper pattern from `packages/cli/test/helpers/in-process-tapd.ts`. Adapt it to live inside `packages/openclaw-plugin/test/helpers/in-process-tapd.ts` if needed — duplication is OK because cross-package test helpers are fragile.

Cover:
- `discoverSocketPath(dataDir)` returns the path
- `OpenClawTapdClient.health()` calls `GET /daemon/health` and returns the response
- `OpenClawTapdClient.sendMessage({ peer, text, scope })` POSTs to `/api/messages`
- `OpenClawTapdClient.connect({ inviteUrl })` POSTs to `/api/connect`
- ... one test per endpoint
- Error handling: when tapd is not running, throws a clear `TapdNotRunningError`

- [ ] **Step 3: Implement**

```ts
import { request, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

const DEFAULT_SOCKET_NAME = ".tapd.sock";
const DEFAULT_TIMEOUT_MS = 10_000;

export class TapdNotRunningError extends Error {
	constructor(socketPath: string) {
		super(
			`tapd is not running (socket not found at ${socketPath}). ` +
			`Start it with: tap daemon start`,
		);
		this.name = "TapdNotRunningError";
	}
}

export class TapdHttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "TapdHttpError";
	}
}

export interface OpenClawTapdClientOptions {
	dataDir?: string;
	socketPath?: string;
	timeoutMs?: number;
}

export function resolveSocketPath(options: OpenClawTapdClientOptions): string {
	if (options.socketPath) return options.socketPath;
	const dataDir = options.dataDir ?? `${process.env.HOME ?? "~"}/.trustedagents`;
	return join(dataDir, DEFAULT_SOCKET_NAME);
}

export class OpenClawTapdClient {
	private readonly socketPath: string;
	private readonly timeoutMs: number;

	constructor(options: OpenClawTapdClientOptions = {}) {
		this.socketPath = resolveSocketPath(options);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async health(): Promise<unknown> {
		return await this.get("/daemon/health");
	}

	async drainNotifications(): Promise<{ notifications: TapNotification[] }> {
		return await this.get<{ notifications: TapNotification[] }>("/api/notifications/drain");
	}

	async sendMessage(input: { peer: string; text: string; scope?: string; autoGenerated?: boolean }): Promise<unknown> {
		return await this.post("/api/messages", input);
	}

	async connect(input: { inviteUrl: string; waitMs?: number }): Promise<unknown> {
		return await this.post("/api/connect", input);
	}

	async transfer(input: { asset: string; amount: string; chain?: string; toAddress: string }): Promise<unknown> {
		return await this.post("/api/transfers", input);
	}

	async requestFunds(input: unknown): Promise<unknown> {
		return await this.post("/api/funds-requests", input);
	}

	async publishGrants(input: unknown): Promise<unknown> {
		return await this.post("/api/grants/publish", input);
	}

	async requestGrants(input: unknown): Promise<unknown> {
		return await this.post("/api/grants/request", input);
	}

	async requestMeeting(input: unknown): Promise<unknown> {
		return await this.post("/api/meetings", input);
	}

	async respondMeeting(schedulingId: string, input: unknown): Promise<unknown> {
		return await this.post(`/api/meetings/${encodeURIComponent(schedulingId)}/respond`, input);
	}

	async cancelMeeting(schedulingId: string, input: unknown): Promise<unknown> {
		return await this.post(`/api/meetings/${encodeURIComponent(schedulingId)}/cancel`, input);
	}

	async listPending(): Promise<unknown> {
		return await this.get("/api/pending");
	}

	async resolvePending(requestId: string, approve: boolean, body: { note?: string; reason?: string } = {}): Promise<unknown> {
		const verb = approve ? "approve" : "deny";
		return await this.post(`/api/pending/${encodeURIComponent(requestId)}/${verb}`, body);
	}

	async createInvite(input: { expiresInSeconds?: number } = {}): Promise<unknown> {
		return await this.post("/api/invites", input);
	}

	async sync(): Promise<unknown> {
		return await this.post("/daemon/sync", {});
	}

	async shutdown(): Promise<unknown> {
		return await this.post("/daemon/shutdown", {});
	}

	get socketPathPublic(): string {
		return this.socketPath;
	}

	private async get<T = unknown>(path: string): Promise<T> {
		return await this.request<T>("GET", path, undefined);
	}

	private async post<T = unknown>(path: string, body: unknown): Promise<T> {
		return await this.request<T>("POST", path, body);
	}

	private async request<T>(method: string, path: string, body: unknown): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const payload = body !== undefined ? JSON.stringify(body) : undefined;
			const headers: Record<string, string> = {
				Accept: "application/json",
			};
			if (payload !== undefined) {
				headers["Content-Type"] = "application/json";
				headers["Content-Length"] = String(Buffer.byteLength(payload));
			}

			const req = request(
				{
					socketPath: this.socketPath,
					method,
					path,
					headers,
					timeout: this.timeoutMs,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						const raw = Buffer.concat(chunks).toString("utf-8");
						let parsed: unknown;
						try {
							parsed = raw ? JSON.parse(raw) : undefined;
						} catch {
							reject(new TapdHttpError(res.statusCode ?? 0, "invalid_json", `tapd returned invalid JSON: ${raw.slice(0, 200)}`));
							return;
						}
						if ((res.statusCode ?? 0) >= 400) {
							const error = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
							reject(
								new TapdHttpError(
									res.statusCode ?? 0,
									error?.code ?? "unknown",
									error?.message ?? `tapd returned HTTP ${res.statusCode}`,
								),
							);
							return;
						}
						resolve(parsed as T);
					});
					res.on("error", reject);
				},
			);

			req.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
					reject(new TapdNotRunningError(this.socketPath));
				} else {
					reject(err);
				}
			});

			req.on("timeout", () => {
				req.destroy();
				reject(new Error(`tapd request timed out after ${this.timeoutMs}ms`));
			});

			if (payload !== undefined) {
				req.write(payload);
			}
			req.end();
		});
	}
}

export interface TapNotification {
	id: string;
	type: "info" | "escalation" | "auto-reply" | "summary";
	oneLiner: string;
	createdAt: string;
	data?: Record<string, unknown>;
}
```

- [ ] **Step 4: Run tests, expect pass after iteration**

Run: `bun run --cwd packages/openclaw-plugin test test/tapd-client.test.ts`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(openclaw-plugin): add HTTP-over-Unix-socket client for tapd"
```

---

## Task 2: Add `notifications-drain.ts` helper

**Files:**
- Create: `packages/openclaw-plugin/src/notifications-drain.ts`
- Create: `packages/openclaw-plugin/test/notifications-drain.test.ts`

A small helper that wraps `client.drainNotifications()` and formats the result as the `[TAP Notifications]` block the existing `before_prompt_build` hook returns. Same format, same labels. Preserves behavior end users see.

- [ ] **Step 1: Write the failing test**

Cover:
- Empty drain returns `null`
- Single notification renders with its label
- Multiple notifications all render
- Truncation at 20 notifications with a "more omitted" line
- Returns `null` if all notifications have empty oneLiners

- [ ] **Step 2: Implement**

```ts
import type { OpenClawTapdClient, TapNotification } from "./tapd-client.js";

const LABELS: Record<TapNotification["type"], string> = {
	info: "INFO",
	escalation: "ESCALATION",
	"auto-reply": "AUTO-REPLY",
	summary: "SUMMARY",
};

const MAX_NOTIFICATIONS = 20;

export async function drainAndFormatNotifications(
	client: OpenClawTapdClient,
): Promise<{ prependContext: string } | null> {
	const result = await client.drainNotifications();
	const notifications = result.notifications ?? [];
	if (notifications.length === 0) return null;

	const lines = ["[TAP Notifications]"];
	let rendered = 0;
	for (const notification of notifications.slice(0, MAX_NOTIFICATIONS)) {
		const label = LABELS[notification.type] ?? "INFO";
		const oneLiner = (notification.oneLiner ?? "").trim();
		if (!oneLiner) continue;
		lines.push(`- ${label}: ${oneLiner}`);
		rendered += 1;
	}
	if (rendered === 0) return null;

	const remaining = notifications.length - MAX_NOTIFICATIONS;
	if (remaining > 0) {
		lines.push(`- SUMMARY: ${remaining} more TAP notifications omitted.`);
	}

	return { prependContext: lines.join("\n") };
}
```

- [ ] **Step 3: Run tests, expect pass**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(openclaw-plugin): add notifications drain + format helper"
```

---

## Task 3: Add `escalation-watcher.ts`

**Files:**
- Create: `packages/openclaw-plugin/src/escalation-watcher.ts`
- Create: `packages/openclaw-plugin/test/escalation-watcher.test.ts`

The escalation watcher subscribes to tapd's SSE event stream over the Unix socket, listens for events that should wake the OpenClaw agent (`action.pending`, certain `connection.requested` cases), and calls the OpenClaw heartbeat API when one arrives.

The challenge: SSE over a Unix socket requires HTTP/1.1 with the response staying open. Use `node:http`'s `request` with `{socketPath, ...}` and read the response stream chunk by chunk, parsing SSE framing (lines, `event:`, `data:`, `\n\n`).

- [ ] **Step 1: Write the failing test**

Cover:
- The watcher connects to tapd's SSE endpoint over the Unix socket
- An `action.pending` event triggers the configured `onEscalation` callback
- Other event types do NOT trigger the callback
- `stop()` closes the connection cleanly

Test against the in-process tapd helper. Publish events via the in-process daemon's runtime and verify the callback fires.

- [ ] **Step 2: Implement**

```ts
import { request, type ClientRequest, type IncomingMessage } from "node:http";

const ESCALATION_EVENT_TYPES = new Set(["action.pending", "connection.requested"]);

export interface EscalationWatcherOptions {
	socketPath: string;
	onEscalation: (event: { type: string; payload: unknown }) => void;
	logger?: { warn: (message: string) => void };
}

export class EscalationWatcher {
	private req: ClientRequest | null = null;
	private res: IncomingMessage | null = null;
	private buffer = "";
	private stopped = false;

	constructor(private readonly options: EscalationWatcherOptions) {}

	start(): void {
		if (this.stopped || this.req) return;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.res) {
			this.res.destroy();
			this.res = null;
		}
		if (this.req) {
			this.req.destroy();
			this.req = null;
		}
	}

	private connect(): void {
		const req = request(
			{
				socketPath: this.options.socketPath,
				method: "GET",
				path: "/api/events/stream",
				headers: { Accept: "text/event-stream" },
			},
			(res) => {
				if (this.stopped) {
					res.destroy();
					return;
				}
				this.res = res;
				res.setEncoding("utf-8");
				res.on("data", (chunk: string) => this.handleChunk(chunk));
				res.on("end", () => this.handleEnd());
				res.on("error", () => this.handleEnd());
			},
		);
		req.on("error", (err) => {
			this.options.logger?.warn(`escalation watcher request error: ${err.message}`);
		});
		req.end();
		this.req = req;
	}

	private handleChunk(chunk: string): void {
		this.buffer += chunk;
		while (this.buffer.includes("\n\n")) {
			const idx = this.buffer.indexOf("\n\n");
			const block = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 2);
			this.parseBlock(block);
		}
	}

	private parseBlock(block: string): void {
		let eventType = "";
		let dataLine = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) eventType = line.slice("event:".length).trim();
			else if (line.startsWith("data:")) dataLine = line.slice("data:".length).trim();
		}
		if (!eventType || !dataLine) return;
		if (!ESCALATION_EVENT_TYPES.has(eventType)) return;
		try {
			const payload = JSON.parse(dataLine);
			this.options.onEscalation({ type: eventType, payload });
		} catch {
			// Ignore malformed payloads.
		}
	}

	private handleEnd(): void {
		if (this.stopped) return;
		// Reconnect after a short backoff. The Unix socket should always be available
		// when tapd is running; if it goes away, we wait briefly and retry.
		setTimeout(() => {
			if (!this.stopped) this.connect();
		}, 1000);
	}
}
```

- [ ] **Step 3: Run tests, expect pass**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(openclaw-plugin): add SSE escalation watcher that wakes the agent"
```

---

## Task 4: Rewrite `plugin.ts`

**Files:**
- Modify: `packages/openclaw-plugin/src/plugin.ts`

Replace the current `OpenClawTapRegistry` construction with the new HTTP client + escalation watcher + drain hook.

```ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { toErrorMessage } from "trusted-agents-core";
import { parseTapOpenClawPluginConfig, tapOpenClawPluginConfigSchema } from "./config.js";
import { EscalationWatcher } from "./escalation-watcher.js";
import { drainAndFormatNotifications } from "./notifications-drain.js";
import { resolveOpenClawMainSessionKey } from "./main-session.js"; // ⚠ delete after Task 5
import { OpenClawTapdClient } from "./tapd-client.js";
import { createTapGatewayTool } from "./tool.js";

const plugin = {
	id: "trusted-agents-tap",
	name: "Trusted Agents TAP",
	description:
		"Run the Trusted Agents Protocol inside OpenClaw Gateway via the local tapd daemon.",
	configSchema: tapOpenClawPluginConfigSchema,
	register(api: OpenClawPluginApi) {
		const pluginConfig = parseTapOpenClawPluginConfig(api.pluginConfig);
		const client = new OpenClawTapdClient({
			dataDir: pluginConfig.dataDir,
			socketPath: pluginConfig.tapdSocketPath,
		});

		const sessionKey = resolveOpenClawMainSessionKey(api.config);

		const escalationWatcher = new EscalationWatcher({
			socketPath: client.socketPathPublic,
			logger: { warn: (msg) => api.logger.warn(`[trusted-agents-tap] ${msg}`) },
			onEscalation: (event) => {
				api.runtime.system.requestHeartbeatNow?.();
				api.runtime.system.enqueueSystemEvent?.({
					type: "tap.escalation",
					sessionKey,
					payload: event.payload,
				});
			},
		});

		api.registerService({
			id: "trusted-agents-tap-runtime",
			start: async () => {
				try {
					await client.health();
					escalationWatcher.start();
				} catch (error: unknown) {
					api.logger.error(
						`[trusted-agents-tap] tapd is not reachable: ${toErrorMessage(error)}. ` +
						`Run 'tap daemon start' to launch it. The TAP gateway tool will return errors until then.`,
					);
				}
			},
			stop: async () => {
				escalationWatcher.stop();
			},
		});

		api.registerTool(createTapGatewayTool(client));

		api.on("before_prompt_build", async () => {
			try {
				return await drainAndFormatNotifications(client);
			} catch (error: unknown) {
				api.logger.warn(
					`[trusted-agents-tap] notification drain failed: ${toErrorMessage(error)}`,
				);
				return null;
			}
		});
	},
};

export default plugin;
```

The `main-session.ts` import will be deleted in Task 5.

- [ ] **Step 1: Apply the rewrite**
- [ ] **Step 2: Don't run tests yet — `tool.ts` still references the old registry**

---

## Task 5: Rewrite `tool.ts`

**Files:**
- Modify: `packages/openclaw-plugin/src/tool.ts`
- Modify: `packages/openclaw-plugin/test/tool.test.ts` (or create if it didn't exist)

The schema (`TapGatewayToolSchema`) stays exactly as today. Only `executeTapGatewayAction` changes — instead of calling `registry.X(...)`, it calls `client.X(...)`.

The function signature changes to take `OpenClawTapdClient` instead of `OpenClawTapRegistry`.

```ts
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { isEthereumAddress, normalizeGrantInput } from "trusted-agents-core";
import type { OpenClawTapdClient } from "./tapd-client.js";

const ACTIONS = [
	"status",
	"sync",
	"restart",
	"create_invite",
	"connect",
	"send_message",
	"publish_grants",
	"request_grants",
	"request_funds",
	"transfer",
	"request_meeting",
	"respond_meeting",
	"cancel_meeting",
	"list_pending",
	"resolve_pending",
] as const;

// (TapGatewayToolSchema definition stays exactly as today — copy verbatim from existing tool.ts)
export const TapGatewayToolSchema = /* ... */;

interface TapGatewayToolParams {
	// (interface stays exactly as today)
}

export function createTapGatewayTool(client: OpenClawTapdClient): AnyAgentTool {
	return {
		name: "tap_gateway",
		label: "TAP Gateway",
		description:
			"Operate the Trusted Agents Protocol via the local tapd daemon. Use this for status, sync, connect, messaging, grants, fund requests, transfers, and pending approval resolution.",
		parameters: TapGatewayToolSchema,
		async execute(_toolCallId, params) {
			return json(await executeTapGatewayAction(client, params as TapGatewayToolParams));
		},
	} as AnyAgentTool;
}

async function executeTapGatewayAction(
	client: OpenClawTapdClient,
	params: TapGatewayToolParams,
): Promise<unknown> {
	switch (params.action) {
		case "status":
			return await client.health();
		case "sync":
			return await client.sync();
		case "restart":
			return await client.shutdown();
		case "create_invite":
			return await client.createInvite({ expiresInSeconds: params.expiresInSeconds });
		case "connect":
			return await client.connect({ inviteUrl: requireString(params.inviteUrl, "inviteUrl") });
		case "send_message":
			return await client.sendMessage({
				peer: requireString(params.peer, "peer"),
				text: requireString(params.text, "text"),
				scope: optionalString(params.scope),
				autoGenerated: params.autoGenerated,
			});
		case "publish_grants":
			return await client.publishGrants({
				peer: requireString(params.peer, "peer"),
				grantSet: normalizeGrantInput(params.grantSet),
				note: optionalString(params.note),
			});
		case "request_grants":
			return await client.requestGrants({
				peer: requireString(params.peer, "peer"),
				grantSet: normalizeGrantInput(params.grantSet),
				note: optionalString(params.note),
			});
		case "request_funds":
			return await client.requestFunds({
				peer: requireString(params.peer, "peer"),
				asset: params.asset ?? "native",
				amount: requireAmount(params.amount, "amount"),
				chain: optionalString(params.chain),
				toAddress: normalizeAddress(params.toAddress),
				note: optionalString(params.note),
			});
		case "transfer":
			return await client.transfer({
				asset: params.asset ?? "native",
				amount: requireAmount(params.amount, "amount"),
				chain: optionalString(params.chain),
				toAddress: requireAddress(params.toAddress, "toAddress"),
			});
		case "request_meeting":
			return await client.requestMeeting({
				peer: requireString(params.peer, "peer"),
				title: requireString(params.title, "title"),
				duration: typeof params.duration === "number" ? params.duration : 60,
				preferred: optionalString(params.preferred),
				location: optionalString(params.location),
				note: optionalString(params.note),
			});
		case "respond_meeting":
			return await client.respondMeeting(
				requireString(params.schedulingId, "schedulingId"),
				{
					action: requireString(params.meetingAction, "meetingAction"),
					reason: optionalString(params.reason),
				},
			);
		case "cancel_meeting":
			return await client.cancelMeeting(
				requireString(params.schedulingId, "schedulingId"),
				{ reason: optionalString(params.reason) },
			);
		case "list_pending":
			return await client.listPending();
		case "resolve_pending":
			return await client.resolvePending(
				requireString(params.requestId, "requestId"),
				requireBoolean(params.approve, "approve"),
				{ note: optionalString(params.note), reason: optionalString(params.reason) },
			);
		default:
			params.action satisfies never;
			throw new Error(`Unsupported TAP Gateway action: ${String(params.action)}`);
	}
}

// Helper functions (json, requireString, requireAmount, requireBoolean, requireAddress, normalizeAddress, optionalString)
// stay exactly as today — copy verbatim from existing tool.ts
```

**Critical:** preserve every helper function and the `TapGatewayToolSchema` definition verbatim from the existing `tool.ts`. Only the `executeTapGatewayAction` body and the `createTapGatewayTool` parameter type change.

- [ ] **Step 1: Apply the rewrite**
- [ ] **Step 2: Update or create `test/tool.test.ts`**
- [ ] **Step 3: Run lint, typecheck, tests** (will still fail because main-session.ts is referenced from plugin.ts)

---

## Task 6: Shrink `config.ts` and delete dead code

**Files:**
- Modify: `packages/openclaw-plugin/src/config.ts`
- Delete: `packages/openclaw-plugin/src/main-session.ts`
- Delete: `packages/openclaw-plugin/src/registry.ts`
- Delete: `packages/openclaw-plugin/src/notification-queue.ts`
- Delete: `packages/openclaw-plugin/src/event-classifier.ts`
- Modify: `packages/openclaw-plugin/src/plugin.ts` (remove `main-session` import)

Shrink `config.ts` to the minimum needed:

```ts
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const tapOpenClawPluginConfigSchema = Type.Object({
	dataDir: Type.Optional(
		Type.String({
			description: "TAP data directory. Defaults to TAP_DATA_DIR or ~/.trustedagents.",
		}),
	),
	tapdSocketPath: Type.Optional(
		Type.String({
			description: "Override path to tapd's Unix socket. Default: <dataDir>/.tapd.sock",
		}),
	),
});

export type TapOpenClawPluginConfig = Static<typeof tapOpenClawPluginConfigSchema>;

export function parseTapOpenClawPluginConfig(raw: unknown): TapOpenClawPluginConfig {
	if (raw === undefined || raw === null) return {};
	const result = Value.Convert(tapOpenClawPluginConfigSchema, raw);
	const errors = [...Value.Errors(tapOpenClawPluginConfigSchema, result)];
	if (errors.length > 0) {
		throw new Error(
			`Invalid trusted-agents-tap plugin config: ${errors.map((e) => e.message).join(", ")}`,
		);
	}
	return result as TapOpenClawPluginConfig;
}
```

Delete `main-session.ts`, `registry.ts`, `notification-queue.ts`, `event-classifier.ts`.

Update `plugin.ts` to remove the `resolveOpenClawMainSessionKey` import and replace `sessionKey` with a static identifier or drop it entirely if it's only used for the system event payload (which can use a stable string).

- [ ] **Step 1: Grep for any remaining imports of the deleted files across the entire repo**

Run:
```bash
grep -rn "from.*openclaw-plugin/src/(registry|notification-queue|main-session|event-classifier)" packages/
```

If any callers exist, fix them in this task.

- [ ] **Step 2: Delete the files**
- [ ] **Step 3: Update `plugin.ts` to remove the dead import**
- [ ] **Step 4: Update `config.ts`**
- [ ] **Step 5: Run `bun run --cwd packages/openclaw-plugin typecheck`**
- [ ] **Step 6: Fix any errors that surface**
- [ ] **Step 7: Run `bun run --cwd packages/openclaw-plugin test`**
- [ ] **Step 8: Commit**

```bash
git commit -m "refactor(openclaw-plugin): delete registry, queue, classifier, main-session"
```

---

## Task 7: Update test surface

**Files:**
- Delete: `packages/openclaw-plugin/test/registry.test.ts` (if exists)
- Delete: `packages/openclaw-plugin/test/notification-queue.test.ts` (if exists)
- Delete: `packages/openclaw-plugin/test/main-session.test.ts` (if exists)
- Delete: `packages/openclaw-plugin/test/event-classifier.test.ts` (if exists — Phase 1 may have already removed it)
- Create: `packages/openclaw-plugin/test/plugin.test.ts` — sanity test of the `register()` function against a fake `OpenClawPluginApi`
- Create: `packages/openclaw-plugin/test/helpers/in-process-tapd.ts` — local copy of the pattern (or import from cli helpers if cross-package import works)

The remaining test surface should cover:
- `tapd-client.ts` — already covered by Task 1's tests
- `notifications-drain.ts` — already covered by Task 2's tests
- `escalation-watcher.ts` — already covered by Task 3's tests
- `tool.ts` — verifies each `tap_gateway` action calls the right client method with the right arguments. Mock the client.
- `plugin.ts` — sanity test that `register()` wires the tool, the service, and the hook against a fake plugin API.

- [ ] **Step 1: Inventory existing tests, identify which to delete**
- [ ] **Step 2: Delete obsolete tests**
- [ ] **Step 3: Write new `plugin.test.ts` and `tool.test.ts`**
- [ ] **Step 4: Run `bun run --cwd packages/openclaw-plugin test`**
- [ ] **Step 5: Commit**

```bash
git commit -m "test(openclaw-plugin): replace registry/queue tests with thin-plugin tests"
```

---

## Task 8: Final Phase 5 verification

- [ ] **Step 1: Run full repo tests**

```bash
bun run lint && bun run typecheck && bun run test
```

- [ ] **Step 2: Inventory `packages/openclaw-plugin/src/`**

Should now contain only:
- `plugin.ts`
- `tool.ts`
- `config.ts`
- `tapd-client.ts`
- `notifications-drain.ts`
- `escalation-watcher.ts`

Run: `find packages/openclaw-plugin/src -name "*.ts" -exec wc -l {} \; | sort -n -r`

Expected total: ~700-900 lines (down from ~1600).

- [ ] **Step 3: Run e2e mock tests**

```bash
bun run --cwd packages/cli test test/e2e/e2e-mock.test.ts
```

- [ ] **Step 4: Final commit if anything outstanding**

```bash
git commit -m "chore(openclaw-plugin): final phase 5 cleanup"
```

**Phase 5 complete.** OpenClaw plugin is a thin host adapter. Every TAP protocol concern lives in tapd. The plugin shrunk from ~1600 lines to ~700-900, with no protocol logic remaining. The next thing is the v2 SQLite migration, which collapses three storage layers into one and adds the channel primitive — a separate spec to design.
