# tapd Phase 3: CLI Thin-Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or run inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor every transport-touching CLI command to be a thin HTTP client of `tapd`. Add a `lib/tapd-client.ts` HTTP client. Add `tap daemon` and `tap ui` commands. Tapd grows the write endpoints (`POST /api/messages`, `POST /api/connect`, etc.) needed to back the CLI commands. After Phase 3, the CLI no longer constructs its own `TapMessagingService` for transport-touching commands — it sends HTTP requests to the running daemon.

**Architecture:** All transport-touching commands become thin HTTP clients. Each command builds a request, calls tapd, formats the response, exits. The daemon owns transport, journal, conversation logging, signing — everything that used to be in `cli-runtime.ts`. Local commands (`init`, `register`, `config`, `contacts list/show`, etc.) stay local, reading files directly. Write-shaped local commands (`contacts remove`, `permissions revoke`) route through tapd when it's running so two processes never write to the same file.

**Tech stack:** No new dependencies. Reuses `node:http` for the HTTP client. The CLI keeps using commander, vitest, the existing output helpers. The new daemon control commands use the same `node:child_process` and service-manager patterns used today by `tap install`.

**Out of scope for Phase 3:** lazy auto-start (the CLI errors with "run `tap daemon start`" if tapd isn't reachable; we add explicit start in this phase but not auto-spawn on first command); service manager integration via launchctl/systemd (manual `nohup` is fine for Phase 3); the OpenClaw and Hermes plugin migrations (those are Phases 4 and 5).

**Note for executors — read this carefully.**

This phase is a coordinated change across two packages: `packages/tapd` grows the write endpoints, `packages/cli` shrinks its commands to thin HTTP clients. Build them together, task by task, so each CLI command's refactor lands at the same time as the tapd endpoint it depends on.

When you hit a TypeScript error or runtime failure that contradicts the plan: read the actual source (`packages/tapd/src/...`, `packages/core/src/runtime/service.ts`, `packages/cli/src/commands/...`), update both your implementation and your tests, and continue without escalating. The plan is a guide; the committed test against real types is the contract.

The existing CLI command files contain the canonical input/output contract for each command. **The refactor MUST preserve their JSON output shape**, because users have scripts depending on it. If you're unsure what a command outputs, read the existing implementation in `packages/cli/src/commands/<name>.ts` and replicate its `success(...)` payload exactly. The plan calls this out in each task.

The tests for these commands live in `packages/cli/test/`. Most of them use `setCliRuntimeOverride` to inject a fake `TapRuntime`. The refactor changes the CLI commands so they no longer construct a `TapRuntime` for transport-touching commands — instead they call tapd. Existing tests that exercise the `setCliRuntimeOverride` path need to be replaced with tests that mock the new `tapd-client` HTTP layer or run against an in-process tapd. This is mechanical but tedious — budget time for it.

---

## File map

**New files in `packages/tapd/`:**

```
packages/tapd/src/http/routes/
  messages.ts                # POST /api/messages
  connect.ts                 # POST /api/connect
  transfers.ts               # POST /api/transfers
  funds-requests.ts          # POST /api/funds-requests
  meetings.ts                # POST /api/meetings, POST /api/meetings/:id/respond, POST /api/meetings/:id/cancel
  grants.ts                  # POST /api/grants/publish, POST /api/grants/request
  permissions.ts             # POST /api/permissions/update
  contacts-write.ts          # POST /api/contacts/:id/revoke
packages/tapd/test/unit/routes/
  (one test file per new route)
```

**New files in `packages/cli/`:**

```
packages/cli/src/lib/tapd-client.ts          # typed HTTP client + lazy-start helper
packages/cli/src/commands/daemon-start.ts
packages/cli/src/commands/daemon-stop.ts
packages/cli/src/commands/daemon-status.ts
packages/cli/src/commands/daemon-restart.ts
packages/cli/src/commands/daemon-logs.ts
packages/cli/src/commands/ui.ts
packages/cli/test/lib/tapd-client.test.ts
packages/cli/test/helpers/in-process-tapd.ts # spawn/stop a tapd in-process for tests
```

**Modified in `packages/cli/`:**

```
packages/cli/src/cli.ts                       # register new commands, change message-listen behavior
packages/cli/src/lib/cli-runtime.ts           # narrow scope: only used for local commands now
packages/cli/src/commands/message-send.ts     # → tapd HTTP call
packages/cli/src/commands/connect.ts          # → tapd HTTP call (drop queueing logic)
packages/cli/src/commands/transfer.ts         # → tapd HTTP call
packages/cli/src/commands/message-request-funds.ts  # → tapd HTTP call
packages/cli/src/commands/message-request-meeting.ts  # → tapd HTTP call
packages/cli/src/commands/message-respond-meeting.ts  # → tapd HTTP call
packages/cli/src/commands/message-cancel-meeting.ts   # → tapd HTTP call
packages/cli/src/commands/permissions-update.ts # → tapd HTTP call
packages/cli/src/commands/message-listen.ts   # SSE tail — semantics change
packages/cli/src/commands/message-sync.ts     # → POST /daemon/sync
packages/cli/src/commands/contacts-remove.ts  # → tapd HTTP call when tapd running, else local
packages/cli/src/commands/permissions-revoke.ts # same pattern
packages/cli/test/<command>.test.ts           # update each test to use tapd-client mocks or in-process tapd
packages/cli/test/e2e/e2e-mock.test.ts        # start in-process tapd in beforeAll
packages/cli/test/e2e/e2e-live.test.ts        # same
packages/cli/test/e2e/helpers.ts              # add tapd lifecycle helpers
```

**Modified in `packages/tapd/`:**

```
packages/tapd/src/daemon.ts                   # register new write routes
packages/tapd/src/http/routes/notifications.ts  # already exists, no change
packages/tapd/src/http/router.ts              # may need POST handler ergonomics — check
```

The hermes daemon (`packages/cli/src/hermes/`) is NOT touched in Phase 3 — that's Phase 4. Hermes users keep their existing daemon.

---

## Pre-flight: read these files

Before starting, the implementer should skim:

1. `packages/cli/src/commands/message-send.ts` — the simplest transport-touching command. Read it to understand the input/output contract.
2. `packages/cli/src/commands/connect.ts` — the most complex transport-touching command. Read it to understand what edge cases (waitMs, queueing, polling) the simplification removes.
3. `packages/cli/src/commands/message-listen.ts` — currently owns transport. Read to understand what becomes an SSE tail.
4. `packages/cli/src/lib/cli-runtime.ts` — what gets stripped down.
5. `packages/tapd/src/daemon.ts` — where new routes register.
6. `packages/tapd/src/http/routes/conversations.ts` — pattern for a route module.
7. `packages/core/src/runtime/service.ts` — find `sendMessage`, `connect`, `requestFunds`, `requestMeeting`, `cancelMeeting`, `revokeConnection`, and any other methods you'll need to call from new tapd routes. **Read their signatures and return types.**
8. `packages/cli/test/connect.test.ts` and `packages/cli/test/message-send.test.ts` — patterns for command tests.
9. `packages/cli/test/e2e/scenarios.ts` — the canonical scenario list shared by mock and live e2e.

---

## Task 1: Add tapd write endpoints — message send

**Why first:** `message/send` is the simplest transport-touching operation in TAP. Building its endpoint first lets us validate the entire shape (route handler → service call → response) before doing the more complex operations.

**Files:**
- Create: `packages/tapd/src/http/routes/messages.ts`
- Create: `packages/tapd/test/unit/routes/messages.test.ts`
- Modify: `packages/tapd/src/daemon.ts` (register the route)

- [ ] **Step 1: Read the existing CLI command's input/output**

Read `packages/cli/src/commands/message-send.ts`. Note the input parameters (peer, text, optional scope) and the success payload shape. This is the contract the new endpoint must back.

- [ ] **Step 2: Read `TapMessagingService.sendMessage` signature**

Read `packages/core/src/runtime/service.ts:1260`. Note the input and return types — they define the route shape.

- [ ] **Step 3: Write the failing route test**

Create `packages/tapd/test/unit/routes/messages.test.ts`. The test mocks a fake service exposing `sendMessage` and verifies the route forwards arguments correctly and returns the result.

```ts
import { describe, expect, it, vi } from "vitest";
import { createMessagesRoute } from "../../../src/http/routes/messages.js";

describe("messages route", () => {
  it("sends a message via the underlying service", async () => {
    const sendMessage = vi.fn(async () => ({
      receipt: { received: true, requestId: "r1", status: "delivered", receivedAt: "x" },
      peerName: "Bob",
      peerAgentId: 42,
      scope: "default",
    }));
    const handler = createMessagesRoute({ sendMessage } as never);

    const result = await handler({}, { peer: "bob", text: "hi", scope: "default" });

    expect(sendMessage).toHaveBeenCalledOnce();
    const args = sendMessage.mock.calls[0];
    expect(args[0]).toBe("bob");
    expect((result as { peerName: string }).peerName).toBe("Bob");
  });

  it("rejects requests missing peer or text", async () => {
    const handler = createMessagesRoute({ sendMessage: vi.fn() } as never);
    await expect(handler({}, {})).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Implement the route**

Create `packages/tapd/src/http/routes/messages.ts`:

```ts
import type { TapMessagingService } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";

interface SendMessageBody {
  peer: string;
  text: string;
  scope?: string;
}

function isSendMessageBody(value: unknown): value is SendMessageBody {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.peer === "string" && typeof v.text === "string";
}

export function createMessagesRoute(
  service: TapMessagingService,
): RouteHandler<unknown, unknown> {
  return async (_params, body) => {
    if (!isSendMessageBody(body)) {
      throw new Error("messages POST requires { peer, text, scope? }");
    }
    return await service.sendMessage(body.peer, body.text, body.scope);
  };
}
```

Note: verify the actual `sendMessage` signature in core. The example here assumes `(peer, text, scope?)` — adjust to match reality.

- [ ] **Step 5: Run route test, expect pass**

Run: `bun run --cwd packages/tapd test test/unit/routes/messages.test.ts`
Expected: PASS.

- [ ] **Step 6: Register the route in `daemon.ts`**

Modify `packages/tapd/src/daemon.ts` `buildRouter()` to add:

```ts
const messagesRoute = createMessagesRoute(ensureRuntime());
router.add("POST", "/api/messages", messagesRoute);
```

Note: `ensureRuntime()` is called immediately in route construction, but the route handler is invoked later. Use the same `ensureRuntime()` pattern the existing pending route uses — re-resolve on each request, not at registration time.

- [ ] **Step 7: Add an integration test**

Add to `packages/tapd/test/integration/http-end-to-end.test.ts` a `POST /api/messages returns the service result` test. Use the existing `makeFakeService` pattern; extend the fake to expose a `sendMessage` mock.

- [ ] **Step 8: Run all tapd tests**

Run: `bun run --cwd packages/tapd test`
Expected: all PASS.

- [ ] **Step 9: Lint and typecheck**

Run: `bun run --cwd packages/tapd typecheck && bun run lint`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add packages/tapd/src/http/routes/messages.ts packages/tapd/test/unit/routes/messages.test.ts packages/tapd/src/daemon.ts packages/tapd/test/integration/http-end-to-end.test.ts
git commit -m "feat(tapd): add POST /api/messages route"
```

---

## Task 2: Add tapd write endpoints — connect, transfers, funds-requests

**Pattern:** for each, read the corresponding existing CLI command and the corresponding `TapMessagingService` method, then build a route module that forwards. One commit per route.

For each route below:
1. Read existing CLI command (`packages/cli/src/commands/<name>.ts`) for the contract
2. Read the corresponding `TapMessagingService` method for the signature
3. Write a failing route test
4. Implement the route module
5. Register in `daemon.ts`
6. Add an integration test
7. Run tests, lint, typecheck
8. Commit

**Routes to add in this task:**

- [ ] **`POST /api/connect`** — wraps `service.connect({ inviteUrl, waitMs })`. Test: input validation, forwards to service, returns `TapConnectResult`. Note: drop the queueing-and-polling logic from the CLI side — tapd is single-process so `service.connect` synchronously waits. Reference: `packages/cli/src/commands/connect.ts` and `service.ts:867`.
- [ ] **`POST /api/transfers`** — wraps the transfer execution. Read `packages/cli/src/commands/transfer.ts` for the input shape (peer, amount, asset, chain, toAddress, note). The CLI command currently calls a multi-step flow; on the tapd side it's likely `service.requestFunds` or a direct transfer. **Read carefully** — transfer is the most semantically loaded command. The route should mirror what the existing CLI command does end-to-end. Commit message: `feat(tapd): add POST /api/transfers route`.
- [ ] **`POST /api/funds-requests`** — wraps `service.requestFunds(input)`. Reference: `packages/cli/src/commands/message-request-funds.ts` and `service.ts:1482`.

Each gets its own commit.

---

## Task 3: Add tapd write endpoints — meetings (3 routes)

Build the meetings module with three handlers:

- [ ] **`POST /api/meetings`** — wraps `service.requestMeeting(input)`. Reference: `packages/cli/src/commands/message-request-meeting.ts` and `service.ts:1575`.
- [ ] **`POST /api/meetings/:id/respond`** — wraps the scheduling-response flow. Reference: `packages/cli/src/commands/message-respond-meeting.ts`.
- [ ] **`POST /api/meetings/:id/cancel`** — wraps `service.cancelMeeting(schedulingId, reason?)`. Reference: `packages/cli/src/commands/message-cancel-meeting.ts` and `service.ts:871`.

Single test file `packages/tapd/test/unit/routes/meetings.test.ts` covering all three. Single commit: `feat(tapd): add meetings routes (request, respond, cancel)`.

---

## Task 4: Add tapd write endpoints — grants and permissions

- [ ] **`POST /api/grants/publish`** — wraps the grant publishing flow. Reference: `packages/cli/src/commands/permissions-update.ts` (the publish path).
- [ ] **`POST /api/grants/request`** — wraps the grant request flow. Reference: `packages/cli/src/commands/permissions-update.ts` (the request path).
- [ ] **`POST /api/permissions/update`** — wraps a generic permission update. May be the same as the above two combined; check the CLI command's behavior.
- [ ] **`POST /api/contacts/:id/revoke`** — wraps `service.revokeConnection(contact, reason?)`. Reference: `packages/cli/src/commands/contacts-remove.ts` and `service.ts:1208`.

One commit per route OR a combined commit if they're tightly coupled. The implementer judges.

---

## Task 5: tapd-client library in CLI

**Files:**
- Create: `packages/cli/src/lib/tapd-client.ts`
- Create: `packages/cli/test/lib/tapd-client.test.ts`

A typed HTTP client for tapd, modeled on `packages/ui/lib/api.ts`. Reads the bearer token from `<dataDir>/.tapd-token` and the bound port from `<dataDir>/.tapd.port`. Throws clear errors when tapd isn't running.

- [ ] **Step 1: Write the failing test**

Test the client against a mocked `fetch`. Cover:
- `discoverTapd(dataDir)` returns `{ baseUrl, token }` when both files exist
- `discoverTapd` throws a clear `TapdNotRunningError` with "run `tap daemon start`" hint when port file missing
- `discoverTapd` throws clear error when token file missing
- `TapdClient.sendMessage(...)` POSTs to `/api/messages` with the right body and returns the parsed result
- `TapdClient.connect(...)` POSTs to `/api/connect` with the right body
- ...one test per write endpoint

- [ ] **Step 2: Implement**

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class TapdNotRunningError extends Error {
  constructor() {
    super("tapd is not running. Start it with: tap daemon start");
    this.name = "TapdNotRunningError";
  }
}

export class TapdClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TapdClientError";
  }
}

export interface TapdConnectionInfo {
  baseUrl: string;
  token: string;
}

export async function discoverTapd(dataDir: string): Promise<TapdConnectionInfo> {
  const portPath = join(dataDir, ".tapd.port");
  const tokenPath = join(dataDir, ".tapd-token");
  let port: number;
  let token: string;
  try {
    const portStr = await readFile(portPath, "utf-8");
    port = Number.parseInt(portStr.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) throw new Error("invalid port file");
  } catch {
    throw new TapdNotRunningError();
  }
  try {
    token = (await readFile(tokenPath, "utf-8")).trim();
    if (!token) throw new Error("empty token");
  } catch {
    throw new TapdNotRunningError();
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export class TapdClient {
  constructor(private readonly info: TapdConnectionInfo) {}

  static async forDataDir(dataDir: string): Promise<TapdClient> {
    return new TapdClient(await discoverTapd(dataDir));
  }

  // ... methods for every endpoint, mirroring packages/ui/lib/api.ts
  // get / post helpers as in the UI client
}
```

Implement `sendMessage`, `connect`, `transfer`, `requestFunds`, `requestMeeting`, `respondMeeting`, `cancelMeeting`, `publishGrants`, `requestGrants`, `updatePermissions`, `revokeContact`, `markConversationRead`, `triggerSync`, `health`, plus the read methods (`listContacts`, `listConversations`, `getConversation`, `listPending`, `approvePending`, `denyPending`, `getIdentity`).

- [ ] **Step 3: Run, expect pass after iteration**

Run: `bun run --cwd packages/cli test test/lib/tapd-client.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/tapd-client.ts packages/cli/test/lib/tapd-client.test.ts
git commit -m "feat(cli): add typed tapd HTTP client with discovery"
```

---

## Task 6: tap daemon control commands

**Files:**
- Create: `packages/cli/src/commands/daemon-start.ts` — spawns tapd via `nohup` (or `spawn` with `detached: true`, `unref()`). Writes a pidfile at `<dataDir>/.tapd.pid`. Waits up to 5s for the port file to appear, then prints success.
- Create: `packages/cli/src/commands/daemon-stop.ts` — reads `.tapd.pid`, sends SIGTERM, waits for the port file to disappear, removes the pidfile.
- Create: `packages/cli/src/commands/daemon-status.ts` — calls `discoverTapd(dataDir)`, calls `GET /daemon/health`, prints status.
- Create: `packages/cli/src/commands/daemon-restart.ts` — stop then start.
- Create: `packages/cli/src/commands/daemon-logs.ts` — tails `<dataDir>/.tapd.log` if it exists; otherwise prints a hint that logs require running tapd via `tap daemon start` (which will write to that file).

**Behavior detail for `daemon-start`:** spawn tapd's `bin.js` as a detached process with stdout and stderr redirected to `<dataDir>/.tapd.log`. Use `spawn("node", [pathToBinJs], { detached: true, stdio: ["ignore", logFd, logFd] })`. After spawn, call `child.unref()` so the parent exits cleanly. Write the child's pid to `<dataDir>/.tapd.pid`.

**Test strategy:** unit-test the spawn helpers with a mocked `spawn`. Don't try to actually run tapd in unit tests — the e2e helper handles real-tapd integration testing.

Register the new commands in `packages/cli/src/cli.ts` under a `daemon` parent command:

```ts
const daemon = program.command("daemon").description("Manage the tapd background daemon");
daemon.command("start").action(...);
daemon.command("stop").action(...);
daemon.command("status").action(...);
daemon.command("restart").action(...);
daemon.command("logs").action(...);
```

Commit: `feat(cli): add tap daemon start|stop|status|restart|logs commands`.

---

## Task 7: tap ui command

**Files:**
- Create: `packages/cli/src/commands/ui.ts`

The `tap ui` command:
1. Loads config to find `dataDir`
2. Calls `discoverTapd(dataDir)` (errors with TapdNotRunningError if not running)
3. Constructs the URL: `${baseUrl}/#token=${token}`
4. Opens it in the system browser using `open` (macOS), `xdg-open` (Linux). For now, use Node's `child_process.exec` with platform detection.
5. Prints the URL to stdout so the user can copy it if the browser doesn't open

Register in `cli.ts`:

```ts
program
  .command("ui")
  .description("Open the tapd web dashboard in your browser")
  .action(async (_cmdOpts, command) => {
    const opts = command.optsWithGlobals() as GlobalOptions;
    await uiCommand(opts);
  });
```

Commit: `feat(cli): add tap ui command`.

---

## Task 8: Refactor `tap message send`

**Files:**
- Modify: `packages/cli/src/commands/message-send.ts`
- Modify: `packages/cli/test/message-send.test.ts`

This is the smallest transport-touching command. Refactor first to validate the pattern.

**Before:** the command builds a runtime via `createCliRuntime`, calls `runtime.service.sendMessage(...)`, prints result.

**After:**

```ts
import { TapdClient } from "../lib/tapd-client.js";
import { loadConfig } from "../lib/config-loader.js";
// ... existing imports for output helpers, types

export async function messageSendCommand(
  peer: string,
  text: string,
  opts: GlobalOptions,
  scope?: string,
): Promise<void> {
  const startTime = Date.now();
  try {
    const config = await loadConfig(opts);
    const client = await TapdClient.forDataDir(config.dataDir);
    const result = await client.sendMessage({ peer, text, scope });
    success(
      {
        peer_name: result.peerName,
        peer_agent_id: result.peerAgentId,
        scope: result.scope,
        receipt: result.receipt,
      },
      opts,
      startTime,
    );
  } catch (err) {
    handleCommandError(err, opts);
  }
}
```

The output shape MUST match the existing command's `success(...)` payload exactly. Read the old version, copy the field names, port them across.

**Test refactor:** the existing tests likely use `setCliRuntimeOverride` to inject a fake runtime. Replace those mocks with `vi.stubGlobal("fetch", ...)` mocks that intercept the HTTP calls to tapd. Refer to `packages/ui/test/unit/api.test.ts` for the pattern.

Or, alternatively, write the test against a real in-process tapd via the new `packages/cli/test/helpers/in-process-tapd.ts` helper (see Task 14). That's a heavier test but a more honest one.

The pattern decision: for unit tests, mock `fetch`. For the e2e tests in `test/e2e/`, use the in-process tapd helper.

Run tests, lint, typecheck. Commit: `refactor(cli): make tap message send a tapd HTTP client`.

---

## Task 9: Refactor `tap connect`

**Files:**
- Modify: `packages/cli/src/commands/connect.ts`
- Modify: `packages/cli/test/connect.test.ts`

The most complex transport-touching command. The current implementation has ~270 lines including queueing-and-polling logic. The refactored version should be ~80 lines:

1. Load config
2. Construct `TapdClient`
3. Build invite + verification (those parts can stay, they're local validation)
4. Call `client.connect({ inviteUrl, waitMs })`
5. Format and print the result

**Drop entirely:** the queueing fallback path (`runOrQueueTapCommand`, `isQueuedTapCommandPending`, the polling helper). With single-process tapd, there's no queueing.

**Preserve:** the dry-run output, the JSON success shape, the validation errors, the timeout behavior. The result shapes from `service.connect` are what the route returns, so the CLI command's job is just formatting.

**Tests:** rewrite `packages/cli/test/connect.test.ts` to mock `fetch` instead of injecting a runtime. Cover the same scenarios: dry-run, successful connect, pending result, timeout.

Commit: `refactor(cli): make tap connect a tapd HTTP client`.

---

## Task 10: Refactor `tap transfer` and `tap message request-funds`

**Files:**
- Modify: `packages/cli/src/commands/transfer.ts`
- Modify: `packages/cli/src/commands/message-request-funds.ts`
- Modify: corresponding test files

Same pattern: load config, construct client, call the right method, format response. Preserve output JSON shape.

Two commits, one per command. Or one combined commit if they're tightly related.

---

## Task 11: Refactor meeting commands

**Files:**
- Modify: `packages/cli/src/commands/message-request-meeting.ts`
- Modify: `packages/cli/src/commands/message-respond-meeting.ts`
- Modify: `packages/cli/src/commands/message-cancel-meeting.ts`
- Modify: corresponding test files

Three commands, three commits or one combined commit.

---

## Task 12: Refactor permissions commands

**Files:**
- Modify: `packages/cli/src/commands/permissions-update.ts`
- Modify: corresponding test file

The permissions update command publishes or requests grants. Maps to `client.publishGrants(...)` or `client.requestGrants(...)` or `client.updatePermissions(...)` depending on the actual semantics.

Commit: `refactor(cli): make tap permissions update a tapd HTTP client`.

---

## Task 13: Refactor `tap message listen` to be an SSE tail

**Files:**
- Modify: `packages/cli/src/commands/message-listen.ts`
- Modify: `packages/cli/test/message-listen.test.ts`

**Behavior change.** Today: starts a `TapMessagingService` and listens forever, writing events to stdout. Tomorrow: connects to `tapd's /api/events/stream` SSE endpoint and writes events to stdout. Same UX from the user's perspective; underneath it's now a thin SSE consumer.

Implementation sketch:

```ts
import { discoverTapd } from "../lib/tapd-client.js";
import { loadConfig } from "../lib/config-loader.js";

export async function messageListenCommand(opts: GlobalOptions): Promise<void> {
  const config = await loadConfig(opts);
  const { baseUrl, token } = await discoverTapd(config.dataDir);

  const url = new URL(`${baseUrl}/api/events/stream`);
  url.searchParams.set("token", token);

  // Use native fetch streaming — node 18+ supports it.
  const response = await fetch(url.toString());
  if (!response.body) {
    error("STREAM_ERROR", "no stream body", opts);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  process.stdout.write(`# tapd event stream from ${baseUrl}\n`);

  // SIGINT closes the stream cleanly.
  process.on("SIGINT", () => {
    void reader.cancel();
    process.exit(0);
  });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes("\n\n")) {
      const idx = buffer.indexOf("\n\n");
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        process.stdout.write(`${dataLine.slice("data: ".length)}\n`);
      }
    }
  }
}
```

**Release-notes entry:** this is a breaking change for any user scripting against `tap message listen`. The output is now SSE event JSON, not the legacy event format. Document it.

Test: spin up tapd in-process, run the command in a child process, publish events, verify stdout. Or mock the fetch streaming response.

Commit: `refactor(cli): tap message listen now tails tapd's SSE event stream`.

---

## Task 14: Refactor `tap message sync` and add in-process tapd test helper

**Files:**
- Modify: `packages/cli/src/commands/message-sync.ts`
- Create: `packages/cli/test/helpers/in-process-tapd.ts`

`tap message sync` becomes a one-liner that POSTs to `/daemon/sync`. The response is the sync report; format and print.

```ts
const client = await TapdClient.forDataDir(config.dataDir);
const report = await client.triggerSync();
success({ ...report }, opts, startTime);
```

The helper at `packages/cli/test/helpers/in-process-tapd.ts` lifts the pattern from `packages/ui/test/e2e/fixtures/seed-tapd.ts`: construct a `Daemon` in-process with stub services for tests that need a real tapd. Reuse this in CLI tests that exercise the full HTTP path.

Two commits.

---

## Task 15: Route write-shaped local commands through tapd when running

**Files:**
- Modify: `packages/cli/src/commands/contacts-remove.ts`
- Modify: `packages/cli/src/commands/permissions-revoke.ts`

These commands currently mutate the data dir directly. The fix: if tapd is running (port file + token file both exist), POST to the corresponding tapd endpoint. If tapd is NOT running, fall back to direct file mutation as today.

```ts
const config = await loadConfig(opts);
let usedTapd = false;
try {
  const client = await TapdClient.forDataDir(config.dataDir);
  await client.revokeContact(connectionId, reason);
  usedTapd = true;
} catch (err) {
  if (!(err instanceof TapdNotRunningError)) throw err;
  // Fall through to local mutation.
}

if (!usedTapd) {
  // Existing local mutation logic
}
```

Test both branches: tapd running (HTTP path) and tapd not running (local file path). Commit one per command or combined.

---

## Task 16: Update e2e test scaffolding

**Files:**
- Modify: `packages/cli/test/e2e/e2e-mock.test.ts`
- Modify: `packages/cli/test/e2e/e2e-live.test.ts`
- Modify: `packages/cli/test/e2e/helpers.ts`

Add a `beforeAll` hook that spins up an in-process tapd against the test data dir(s). Add an `afterAll` hook that stops it. The CLI commands inside the scenarios then automatically discover the running tapd and route through it.

The `scenarios.ts` file should NOT need to change — the scenarios are protocol-level, not transport-plumbing-level. The change is purely in the test setup.

Run the full e2e suite: `bun run --cwd packages/cli test test/e2e/e2e-mock.test.ts`. Expected: all scenarios PASS through the tapd path.

Commit: `test(cli): run e2e scenarios through an in-process tapd`.

---

## Task 17: Strip `cli-runtime.ts` to local-only scope

**Files:**
- Modify: `packages/cli/src/lib/cli-runtime.ts`

After all the transport-touching commands have moved off it, `createCliRuntime` is only used by local commands that still need a `TapRuntime` for non-transport operations (calendar setup checks, journal inspection, etc.). The function can be slimmed down: drop the `ownerLabel`, `emitEvents`, `hooks` parameters that only made sense for transport-owning callers.

Verify by `grep`-ing for `createCliRuntime` usages and confirming each remaining caller is a local-only command.

If after the refactor `createCliRuntime` has no remaining callers, delete it entirely.

Commit: `refactor(cli): narrow createCliRuntime to local-command scope (or delete if unused)`.

---

## Task 18: Final Phase 3 verification

- [ ] Run the full repo lint, typecheck, test suites
- [ ] Run e2e mock tests (`bun run --cwd packages/cli test test/e2e/e2e-mock.test.ts`)
- [ ] Manual smoke: `tap daemon start`, then `tap message send` (against a real or stub data dir), then `tap daemon stop`
- [ ] Inventory: count lines in refactored CLI commands. Expected: each is significantly smaller than before. Note totals in the final commit message.
- [ ] If anything is outstanding, commit a final cleanup

```bash
bun run lint && bun run typecheck && bun run test
```

Commit: `chore(cli): final phase 3 cleanup`.

**Phase 3 complete.** All transport-touching CLI commands are thin tapd HTTP clients. CLI users interact with tapd transparently. The next phase migrates the Hermes daemon to use tapd instead of its own in-process runtime.
