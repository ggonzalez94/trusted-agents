# E2E Shared Runtime — Fix XMTP Installation Exhaustion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate XMTP installation exhaustion in E2E tests by sharing one persistent runtime per agent instead of creating a new XMTP client per CLI command.

**Architecture:** Replace polling helpers that call `runCli(["message", "sync", ...])` (each creating a new XMTP client + installation) with direct `TapRuntime` method calls on a persistent runtime that stays started for the duration of the test suite. Commands that don't need XMTP (`balance`, `contacts list`, `permissions show`, `identity resolve-self`, `conversations list`) continue using `runCli`. This drops total installations from 23+ per run to exactly 2 (one per agent).

**Tech Stack:** TypeScript, Vitest, `@trustedagents/sdk` (`TapRuntime`), `trusted-agents-core` (`TapMessagingService`)

---

## Key Insight

`TapMessagingService.withTransportSession()` at `packages/core/src/runtime/service.ts:1364` checks `if (this.running) { return await task(); }` — when the service is already started, `syncOnce()` reuses the existing transport with zero new XMTP installations. The problem is that `runCli` creates a fresh runtime per invocation, so the service is never "already running."

The `TapRuntime` SDK class already exposes all the methods we need: `syncOnce()`, `connect()`, `sendMessage()`, `requestFunds()`, `publishGrants()`, `start()`, `stop()`, plus `trustStore` and `service` getters.

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/cli/test/e2e/helpers.ts` | **Modify** | Add `createAgentSession()` factory, convert polling helpers to accept a runtime |
| `packages/cli/test/e2e/e2e-live.test.ts` | **Modify** | Create shared runtimes in `beforeAll`, replace `runCli` sync/send calls with runtime methods |
| `packages/core/src/transport/xmtp.ts` | **No change** | The `disableAutoRegister` + revoke + register flow stays — it's correct for single-client usage |

## Commands That Stay as `runCli`

These commands do NOT call `createCliRuntime` and don't create XMTP clients, so they're fine:
- `tap init`, `tap register create/update`, `tap invite create`
- `tap identity show/resolve/resolve-self`
- `tap balance`, `tap contacts list/show`, `tap conversations list/show`
- `tap permissions show`

## Commands That Must Switch to Direct Runtime Calls

These currently go through `runCli` → `createCliRuntime` → `XmtpTransport.start()` → new installation:
- `tap message sync` → `runtime.syncOnce()`
- `tap message send` → `runtime.sendMessage(agentId, text)` (but E2E uses runCli for this — check if it's simpler to keep)
- `tap connect` → `runtime.connect({ inviteUrl })`
- `tap permissions grant` → `runtime.publishGrants(peerId, grantSet)`
- `tap permissions revoke` → use `runtime.publishGrants()` with revoked grant
- `tap message request-funds` → `runtime.requestFunds(input)`

---

### Task 1: Add `createAgentSession` to E2E helpers

**Files:**
- Modify: `packages/cli/test/e2e/helpers.ts`

This creates a persistent `TapRuntime` that stays started for the test suite. We use `createCliRuntime` (same as production) but call `service.start()` once and keep it alive.

- [ ] **Step 1: Add the `AgentSession` type and factory**

At the top of `helpers.ts`, add after the imports:

```typescript
import { loadConfig } from "../../src/lib/config-loader.js";
import { createCliRuntime } from "../../src/lib/cli-runtime.js";
import type { TapRuntime } from "@trustedagents/sdk";
import type { CliTapServiceHooks } from "../../src/lib/cli-runtime.js";

export interface AgentSession {
  runtime: TapRuntime;
  stop(): Promise<void>;
}

/**
 * Create a persistent agent session with a started XMTP transport.
 * The transport stays alive for the session's lifetime, so syncOnce()
 * reuses the existing client (0 new XMTP installations per sync).
 */
export async function createAgentSession(opts: {
  dataDir: string;
  hooks?: CliTapServiceHooks;
}): Promise<AgentSession> {
  const config = await loadConfig({ plain: true, dataDir: opts.dataDir });
  const runtime = await createCliRuntime({
    config,
    opts: { plain: true, dataDir: opts.dataDir },
    ownerLabel: "e2e-session",
    hooks: opts.hooks,
  });

  await runtime.service.start();

  return {
    runtime,
    stop: async () => {
      await runtime.service.stop();
    },
  };
}
```

- [ ] **Step 2: Convert `waitForSync` to accept an optional runtime**

Replace the `waitForSync` function to support both modes (runtime-direct for speed, or `runCli` fallback):

```typescript
export async function waitForSync(opts: {
  dataDir: string;
  description: string;
  timeoutMs?: number;
  intervalMs?: number;
  minProcessed?: number;
  runtime?: TapRuntime;
}): Promise<void> {
  const { dataDir, description, timeoutMs = 30_000, intervalMs = 2_000, minProcessed = 1, runtime } = opts;
  const deadline = Date.now() + timeoutMs;

  let lastProcessed = 0;

  while (Date.now() < deadline) {
    if (runtime) {
      const report = await runtime.syncOnce();
      lastProcessed = report.processed;
      if (lastProcessed >= minProcessed) return;
    } else {
      const result = await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);
      if (result.exitCode === 0) {
        try {
          const parsed = parseJsonOutput(result.stdout);
          const data = parsed.data as { processed?: number };
          lastProcessed = data.processed ?? 0;
          if (lastProcessed >= minProcessed) return;
        } catch { /* keep polling */ }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out waiting for sync (${description}). Expected >= ${minProcessed} processed, last saw ${lastProcessed}.`,
  );
}
```

- [ ] **Step 3: Convert `waitForContact` to accept an optional runtime**

```typescript
export async function waitForContact(opts: {
  dataDir: string;
  peerName: string;
  timeoutMs?: number;
  intervalMs?: number;
  runtime?: TapRuntime;
}): Promise<void> {
  const { dataDir, peerName, timeoutMs = 60_000, intervalMs = 2_000, runtime } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Sync to process pending messages
    if (runtime) {
      await runtime.syncOnce();
    } else {
      await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);
    }

    // Check contacts (always via CLI — read-only, no XMTP needed)
    const result = await runCli(["--json", "--data-dir", dataDir, "contacts", "list"]);
    if (result.exitCode === 0) {
      try {
        const parsed = parseJsonOutput(result.stdout);
        const data = parsed.data as { contacts: Array<{ name: string; status: string }> };
        const contact = data.contacts.find((c) => c.name === peerName);
        if (contact?.status === "active") return;
      } catch { /* keep polling */ }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timed out waiting for contact "${peerName}" (${timeoutMs}ms).`);
}
```

- [ ] **Step 4: Convert `waitForStableBaseline` to accept an optional runtime**

```typescript
export async function waitForStableBaseline(
  dataDir: string,
  label: string,
  timeoutMs = 30_000,
  runtime?: TapRuntime,
): Promise<void> {
  // Initial sync
  if (runtime) {
    await runtime.syncOnce();
  } else {
    const initResult = await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);
    if (initResult.exitCode !== 0) {
      throw new Error(`${label}: initial baseline sync failed (exit ${initResult.exitCode}): ${initResult.stderr}`);
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime) {
      const report = await runtime.syncOnce();
      if (report.processed === 0) return;
    } else {
      const result = await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);
      if (result.exitCode === 0) {
        try {
          const parsed = parseJsonOutput(result.stdout);
          const data = parsed.data as { processed?: number };
          if ((data.processed ?? 0) === 0) return;
        } catch { /* keep polling */ }
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  throw new Error(`${label} XMTP baseline did not stabilize within ${timeoutMs}ms`);
}
```

- [ ] **Step 5: Convert `waitForPermissions` to accept an optional runtime**

```typescript
export async function waitForPermissions(
  dataDir: string,
  peer: string,
  predicate: (snapshot: PermissionSnapshot) => boolean,
  timeoutMs = 30_000,
  intervalMs = 2_000,
  runtime?: TapRuntime,
): Promise<PermissionSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: PermissionSnapshot | undefined;

  while (Date.now() < deadline) {
    // Sync first
    if (runtime) {
      await runtime.syncOnce();
    } else {
      await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);
    }

    // Read permissions (no XMTP needed)
    const result = await runCli(["--json", "--data-dir", dataDir, "permissions", "show", peer]);
    if (result.exitCode === 0) {
      const data = (JSON.parse(result.stdout) as { data: PermissionSnapshot }).data;
      lastSnapshot = data;
      if (predicate(data)) return data;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out waiting for permissions for peer "${peer}". Last: ${JSON.stringify(lastSnapshot ?? null)}`,
  );
}
```

- [ ] **Step 6: Run typecheck**

Run: `cd /Users/gustavo/apps/trusted-agents && bun run typecheck`
Expected: PASS (helpers are additive — existing signatures still work)

- [ ] **Step 7: Run tests**

Run: `cd /Users/gustavo/apps/trusted-agents && bun run test`
Expected: 669 passed (no behavior change — the `runtime` param is optional)

- [ ] **Step 8: Commit**

```bash
git add packages/cli/test/e2e/helpers.ts
git commit -m "test(e2e): add createAgentSession and runtime-aware polling helpers"
```

---

### Task 2: Wire shared sessions into e2e-live.test.ts

**Files:**
- Modify: `packages/cli/test/e2e/e2e-live.test.ts`

Replace the XMTP-heavy `runCli` calls with shared runtime calls. The test structure stays the same — same phases, same assertions. Only the transport usage changes.

- [ ] **Step 1: Add shared session state and lifecycle**

In the shared state section (around line 84), add:

```typescript
import type { AgentSession } from "./helpers.js";

let sessionA: AgentSession | undefined;
let sessionB: AgentSession | undefined;
```

Update imports at the top to include `createAgentSession`.

- [ ] **Step 2: Start sessions after Phase 1 registration, before Phase 2 connection**

Add a new "Start XMTP sessions" test at the beginning of Phase 2, before `CREATE_INVITE`:

```typescript
it("Start XMTP sessions", { timeout: 60_000 }, async () => {
  sessionA = await createAgentSession({ dataDir: agentADir });
  sessionB = await createAgentSession({ dataDir: agentBDir });
});
```

This registers exactly 2 XMTP installations (one per agent) for the entire test suite.

- [ ] **Step 3: Update afterAll to stop sessions**

```typescript
afterAll(async () => {
  await agentAListener?.stop();
  await sessionA?.stop();
  await sessionB?.stop();
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Replace waitForStableBaseline calls with runtime-aware versions**

Find all `waitForStableBaseline(agentADir, ...)` calls and pass the runtime:

```typescript
// Before:
await waitForStableBaseline(agentADir, "Agent A");
// After:
await waitForStableBaseline(agentADir, "Agent A", 30_000, sessionA?.runtime);
```

Same for Agent B.

- [ ] **Step 5: Replace Phase 2 connection with runtime.connect()**

Replace the `runCli(["connect", inviteUrl, ...])` call with:

```typescript
it(SCENARIOS.ACCEPT_INVITE.name, { timeout: 120_000 }, async () => {
  const result = await sessionB!.runtime.connect({ inviteUrl });
  expect(result).toBeDefined();
});
```

- [ ] **Step 6: Replace Phase 2 waitForContact calls with runtime-aware versions**

```typescript
await waitForContact({ dataDir: agentADir, peerName: AGENT_B_NAME, runtime: sessionA?.runtime });
await waitForContact({ dataDir: agentBDir, peerName: AGENT_A_NAME, runtime: sessionB?.runtime });
```

- [ ] **Step 7: Replace Phase 3 permissions grant with runtime.publishGrants()**

The existing `runCli(["permissions", "grant", ...])` call writes a grant file and passes it. With the runtime API, we can call `publishGrants()` directly. However, this requires the peer's agentId (a number), not their display name.

Keep `runCli` for the `permissions grant` command since it handles name→id resolution and file parsing. But pass `runtime` to the `waitForSync` and `waitForPermissions` polling helpers:

```typescript
// Sync calls in Phase 3:
await waitForSync({ dataDir: agentBDir, description: "sync grant", runtime: sessionB?.runtime });
await waitForPermissions(agentBDir, AGENT_A_NAME, predicate, 30_000, 2_000, sessionB?.runtime);
```

- [ ] **Step 8: Replace Phase 4 messaging waitForSync calls**

```typescript
await waitForSync({ dataDir: agentBDir, description: "sync message from A", runtime: sessionB?.runtime });
await waitForSync({ dataDir: agentADir, description: "sync message from B", runtime: sessionA?.runtime });
```

The `message send` calls can stay as `runCli` since they only create 1 installation each and are not in polling loops. But if you want to minimize installations, replace with:

```typescript
// Instead of runCli(["message", "send", AGENT_B_NAME, text, ...]):
// Need the agentId, which we can get from contacts
const contacts = await sessionA!.runtime.trustStore.getContacts();
const contactB = contacts.find(c => c.peerDisplayName === AGENT_B_NAME);
await sessionA!.runtime.sendMessage(contactB!.peerAgentId, "Hello from Agent A");
```

- [ ] **Step 9: Replace Phase 5 transfer flow with runtime-aware helpers**

The listener session for Agent A (transfer approval) stays the same — `createMessageListenerSession` already creates a persistent transport. BUT: when the listener starts, it will compete with `sessionA` for the transport lock. Solution: stop `sessionA` before starting the listener, then use the listener's runtime for syncs during Phase 5.

```typescript
// Before starting the listener:
await sessionA?.stop();
sessionA = undefined;

// Start listener (creates its own transport):
agentAListener = await createMessageListenerSession(
  { plain: true, dataDir: agentADir },
  { approveTransfer: async ({ activeTransferGrants }) => activeTransferGrants.length > 0 },
);

// After stopping listener, restart session for remaining commands:
await agentAListener?.stop();
agentAListener = undefined;
sessionA = await createAgentSession({ dataDir: agentADir });
```

For Agent B's syncs during Phase 5, use `sessionB!.runtime`:

```typescript
await waitForSync({ dataDir: agentBDir, description: "transfer result", runtime: sessionB?.runtime, timeoutMs: 60_000 });
```

- [ ] **Step 10: Replace Phase 5 permissions revoke with runtime-aware sync**

After `runCli(["permissions", "revoke", ...])` (which still uses `runCli` since it needs name resolution):

```typescript
await waitForPermissions(agentBDir, AGENT_A_NAME, revokedPredicate, 60_000, 2_000, sessionB?.runtime);
```

- [ ] **Step 11: Replace Phase 5 rejected transfer flow**

```typescript
// Agent B request-funds can stay as runCli (one-shot)
// But syncs use runtime:
await waitForSync({ dataDir: agentADir, description: "rejection cycle", runtime: sessionA?.runtime });
await waitForSync({ dataDir: agentBDir, description: "rejection result", runtime: sessionB?.runtime });
```

- [ ] **Step 12: Run typecheck**

Run: `cd /Users/gustavo/apps/trusted-agents && bun run typecheck`
Expected: PASS

- [ ] **Step 13: Run unit tests**

Run: `cd /Users/gustavo/apps/trusted-agents && bun run test`
Expected: 669 passed (live E2E tests are skipped without wallet env vars)

- [ ] **Step 14: Commit**

```bash
git add packages/cli/test/e2e/e2e-live.test.ts
git commit -m "test(e2e): use shared XMTP sessions to eliminate installation exhaustion

Each agent now creates one XMTP installation for the entire test suite
instead of one per CLI command. Drops total installations from 23+ to 2,
staying well within the XMTP 10-installation per inbox limit."
```

---

### Task 3: Verify and push

- [ ] **Step 1: Run full build + test**

```bash
cd /Users/gustavo/apps/trusted-agents && bun run build && bun run test
```

Expected: All 669 tests pass, all packages build.

- [ ] **Step 2: Push and trigger release**

```bash
git push origin main
```

Then trigger the release workflow with E2E enabled to verify the fix works in CI.

---

## Installation Budget After Fix

| Agent | Before (per run) | After (per run) |
|-------|-----------------|-----------------|
| Agent A | ~10+ (sync polling + send + listener + revoke) | 2 (session + listener) |
| Agent B | ~13+ (sync polling + connect + send + request-funds) | 1 (session only) |
| **Total** | **23+** | **3** |

With 3 installations per run and `revokeAllOtherInstallations()` cleaning up on each `start()`, the inbox budget stays at 3 active installations maximum, well under the 10-installation XMTP limit.
