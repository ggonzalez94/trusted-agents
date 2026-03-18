# TAP Inbound Notification Hook Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a TAP message arrives via XMTP streaming, the OpenClaw plugin classifies it, auto-handles grant-covered transfers, and wakes the agent session for everything else — replacing the current polling model with near-real-time notification.

**Architecture:** Core gains two new hooks (`approveConnection`, extended `approveTransfer` path) and loses `unsafeAutoApproveActions`. The OpenClaw plugin wires these hooks plus a new in-memory notification queue, event classifier, and `before_prompt_build` hook to inject TAP events into the agent's context. `requestHeartbeatNow()` wakes the agent on escalations.

**Tech Stack:** TypeScript (ESM), Bun test runner (vitest), OpenClaw plugin SDK (`openclaw/plugin-sdk`), XMTP transport.

**Spec:** `docs/superpowers/specs/2026-03-18-tap-inbound-notification-hook-design.md`

**Run commands:**
- Lint: `bun run lint`
- Typecheck: `bun run typecheck`
- Test all: `bun run test`
- Test core only: `bun test packages/core/test/unit/runtime/service.test.ts`
- Test plugin only: `bun test packages/openclaw-plugin/test/`

---

## File Map

### Files to modify

| File | Change |
|------|--------|
| `packages/core/src/runtime/service.ts` | Remove `unsafeAutoApproveActions`, change `decideTransfer` to call hook when no grants, add `approveConnection` hook to `processConnectionRequest`, extend `resolvePending` for `CONNECTION_REQUEST` |
| `packages/core/src/runtime/index.ts` | Export new `TapConnectionApprovalContext` type if added |
| `packages/core/test/unit/runtime/service.test.ts` | Update tests that use `unsafeAutoApproveActions`, add tests for new hook paths |
| `packages/openclaw-plugin/src/config.ts` | Remove `unsafeApproveActions` from type, schema, UI hints, parsing |
| `packages/openclaw-plugin/src/registry.ts` | Wire `emitEvent`, `approveTransfer`, `approveConnection` hooks; remove `unsafeAutoApproveActions` passthrough; accept + store `pluginRuntime` for heartbeat/event APIs |
| `packages/openclaw-plugin/src/plugin.ts` | Register `before_prompt_build` hook via `api.on()` |
| `packages/openclaw-plugin/openclaw.plugin.json` | Remove `unsafeApproveActions` from JSON schema |
| `packages/openclaw-plugin/test/config.test.ts` | Remove `unsafeApproveActions` from assertions |
| `packages/openclaw-plugin/test/registry.test.ts` | Remove `unsafeApproveActions` from test fixtures |
| `packages/cli/src/commands/message-listen.ts` | Remove `unsafeApproveActions` option |
| `packages/cli/src/commands/message-sync.ts` | Remove `unsafeApproveActions` option |
| `packages/cli/src/lib/tap-service.ts` | Remove `unsafeAutoApproveActions` from options |
| `packages/cli/src/cli.ts` | Remove `--unsafe-approve-actions` flag from listen/sync commands |
| `packages/openclaw-plugin/skills/trusted-agents-openclaw/SKILL.md` | Document notification behavior, connection escalation |
| `packages/sdk/skills/trusted-agents/messaging/SKILL.md` | Remove `--unsafe-approve-actions` flag references |
| `packages/openclaw-plugin/README.md` | Remove `unsafeApproveActions` from example config |
| `OPENCLAW_PLUGIN_DEPLOYMENT_PLAN.md` | Remove `unsafeApproveActions` from example config |

### Files to create

| File | Purpose |
|------|---------|
| `packages/openclaw-plugin/src/event-classifier.ts` | Pure function: classify emitEvent payload into `"auto-handle" \| "escalate" \| "notify"` |
| `packages/openclaw-plugin/src/notification-queue.ts` | In-memory per-identity queue: push, upgrade, drain, peek. Max 1000 entries with eviction. |
| `packages/openclaw-plugin/test/event-classifier.test.ts` | Unit tests for classifier |
| `packages/openclaw-plugin/test/notification-queue.test.ts` | Unit tests for queue |

---

## Task 1: Remove `unsafeAutoApproveActions` from core

**Files:**
- Modify: `packages/core/src/runtime/service.ts:178,254,279,1664-1670`
- Test: `packages/core/test/unit/runtime/service.test.ts`

- [ ] **Step 1: Update tests that use `unsafeAutoApproveActions`**

Find lines 1110, 1274, 1411 in `service.test.ts`. Each passes `serviceOptions: { unsafeAutoApproveActions: true }`. These tests verify that transfers are auto-approved when the flag is set. Change them to use an `approveTransfer` hook that returns `true` instead:

```typescript
// Replace: serviceOptions: { unsafeAutoApproveActions: true }
// With:
hooks: {
  approveTransfer: async () => true,
},
```

- [ ] **Step 2: Run tests to verify they still pass with hook-based approval**

Run: `bun test packages/core/test/unit/runtime/service.test.ts`
Expected: Tests that used `unsafeAutoApproveActions` should still pass with the hook.

- [ ] **Step 3: Remove `unsafeAutoApproveActions` from `TapServiceOptions` and `TapMessagingService`**

In `packages/core/src/runtime/service.ts`:
- Remove `unsafeAutoApproveActions?: boolean` from `TapServiceOptions` (line 178)
- Remove `private readonly unsafeAutoApproveActions: boolean` (line 254)
- Remove `this.unsafeAutoApproveActions = options.unsafeAutoApproveActions ?? false` (line 279)
- Remove the `if (this.unsafeAutoApproveActions)` block in `decideTransfer()` (lines 1664-1670)

- [ ] **Step 4: Run typecheck and tests**

Run: `bun run typecheck && bun test packages/core/test/unit/runtime/service.test.ts`
Expected: PASS — no remaining references to `unsafeAutoApproveActions` in core.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/test/unit/runtime/service.test.ts
git commit -m "refactor(core): remove unsafeAutoApproveActions from TapMessagingService"
```

---

## Task 2: Change `decideTransfer` to call hook when no grants match

**Files:**
- Modify: `packages/core/src/runtime/service.ts:1672-1678`
- Test: `packages/core/test/unit/runtime/service.test.ts`

- [ ] **Step 1: Write failing test — approveTransfer hook called with empty grants returns null (pending)**

Add to `service.test.ts`:

```typescript
it("leaves transfer pending when approveTransfer returns null and no grants match", async () => {
  const approveTransfer = vi.fn().mockResolvedValue(null);
  // Create service with a contact that has NO transfer grants
  const { service, transport, requestJournal } = await createService({}, {
    trustStore: createMemoryTrustStore([activeContact]),
    hooks: { approveTransfer },
  });
  await service.start();

  // Simulate inbound transfer action/request
  const transferMessage = buildTransferActionRequest();
  await transport.handlers.onRequest!({
    from: activeContact.peerAgentId,
    senderInboxId: "inbox-peer",
    message: transferMessage,
  });
  await service.drain();

  // Hook was called with empty activeTransferGrants
  expect(approveTransfer).toHaveBeenCalledWith(
    expect.objectContaining({ activeTransferGrants: [] }),
  );

  // Request should be pending (not rejected)
  const entry = await requestJournal.getByRequestId(String(transferMessage.id));
  expect(entry?.status).toBe("pending");

  // No rejection response sent
  expect(transport.sentMessages).toHaveLength(0);
  await service.stop();
});
```

Note: You'll need to construct `activeContact` (a contact with active status but no transfer grants in `permissions.grantedByMe`) and `buildTransferActionRequest()` using the existing test helpers. Study the existing transfer-related tests in the file to match the pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/unit/runtime/service.test.ts -t "leaves transfer pending"`
Expected: FAIL — currently the request is rejected, not left pending.

- [ ] **Step 3: Implement the change in `decideTransfer`**

In `packages/core/src/runtime/service.ts`, replace the `transferGrants.length === 0` block:

```typescript
// Before (after removing unsafeAutoApproveActions):
if (transferGrants.length === 0) {
  this.log(
    "warn",
    `Rejecting action request ${request.actionId} from ${contact.peerDisplayName} (#${contact.peerAgentId}) because no matching active transfer grant exists`,
  );
  return false;
}

// After:
if (transferGrants.length === 0) {
  if (this.hooks.approveTransfer) {
    return (
      (await this.hooks.approveTransfer({
        requestId,
        contact,
        request,
        activeTransferGrants: transferGrants,
        ledgerPath: getPermissionLedgerPath(this.context.config.dataDir),
      })) ?? null
    );
  }
  this.log(
    "warn",
    `Rejecting action request ${request.actionId} from ${contact.peerDisplayName} (#${contact.peerAgentId}) because no matching active transfer grant exists`,
  );
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/unit/runtime/service.test.ts -t "leaves transfer pending"`
Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `bun test packages/core/test/unit/runtime/service.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/test/unit/runtime/service.test.ts
git commit -m "feat(core): call approveTransfer hook even when no grants match"
```

---

## Task 3: Add `approveConnection` hook to core

**Files:**
- Modify: `packages/core/src/runtime/service.ts:166-175,1238-1274`
- Modify: `packages/core/src/runtime/index.ts` (export new type)
- Test: `packages/core/test/unit/runtime/service.test.ts`

- [ ] **Step 1: Write failing test — approveConnection hook returning null defers the request**

Add to `service.test.ts`:

```typescript
it("defers connection request when approveConnection returns null", async () => {
  const approveConnection = vi.fn().mockResolvedValue(null);
  const { service, transport, requestJournal } = await createService({}, {
    hooks: { approveConnection },
  });
  await service.start();

  // Build a valid connection request from the peer
  const connectionRequest = buildConnectionRequest(/* use existing helper pattern */);
  await transport.handlers.onRequest!({
    from: PEER_AGENT.agentId,
    senderInboxId: "inbox-peer",
    message: connectionRequest,
  });
  await service.drain();

  // Hook was called
  expect(approveConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      peerAgentId: PEER_AGENT.agentId,
      peerName: PEER_AGENT.registrationFile.name,
    }),
  );

  // No connection/result sent (deferred)
  expect(transport.sentMessages).toHaveLength(0);

  // Request stays pending in journal
  const entry = await requestJournal.getByRequestId(String(connectionRequest.id));
  expect(entry?.status).not.toBe("completed");
  await service.stop();
});
```

Study the existing `processConnectionRequest` tests and use matching fixtures (invite generation, resolver setup, etc.).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/unit/runtime/service.test.ts -t "defers connection request"`
Expected: FAIL — `approveConnection` doesn't exist yet.

- [ ] **Step 3: Add `approveConnection` to `TapServiceHooks` interface**

In `packages/core/src/runtime/service.ts`, add to the `TapServiceHooks` interface:

```typescript
export interface TapServiceHooks {
  approveTransfer?: (context: TapTransferApprovalContext) => Promise<boolean | null>;
  approveConnection?: (context: TapConnectionApprovalContext) => Promise<boolean | null>;
  executeTransfer?: (
    config: TrustedAgentsConfig,
    request: TransferActionRequest,
  ) => Promise<{ txHash: `0x${string}` }>;
  appendLedgerEntry?: (dataDir: string, entry: PermissionLedgerEntry) => Promise<string>;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  emitEvent?: (payload: Record<string, unknown>) => void;
}

export interface TapConnectionApprovalContext {
  peerAgentId: number;
  peerName: string;
  peerChain: string;
}
```

- [ ] **Step 4: Change `processConnectionRequest` to return a deferral signal and call the hook**

The method currently returns `void`. Change it to return `Promise<"processed" | "deferred">`. This signal tells the caller whether to mark the journal entry as completed.

In `processConnectionRequest()` (around line 1262), after invite validation passes and before `handleConnectionRequest()`:

```typescript
private async processConnectionRequest(
  message: ProtocolMessage,
  options?: { skipApprovalHook?: boolean },
): Promise<"processed" | "deferred"> {
  const params = parseConnectionRequest(message);

  const inviteRejectionReason = await this.validateInboundInvite(params.invite);
  if (inviteRejectionReason) {
    // ... existing rejection logic (unchanged) ...
    return "processed";
  }

  // NEW: approval hook check
  if (this.hooks.approveConnection && !options?.skipApprovalHook) {
    const peer = await this.context.resolver.resolveWithCache(
      params.from.agentId,
      params.from.chain,
    );
    const decision = await this.hooks.approveConnection({
      peerAgentId: peer.agentId,
      peerName: peer.registrationFile.name,
      peerChain: params.from.chain,
    });
    if (decision === null) {
      this.log(
        "info",
        `Connection request from ${peer.registrationFile.name} (#${peer.agentId}) deferred for user approval`,
      );
      return "deferred"; // Leave pending — don't send result, don't complete
    }
    if (decision === false) {
      await this.sendConnectionResult(peer, {
        requestId: String(message.id),
        from: { agentId: this.context.config.agentId, chain: this.context.config.chain },
        status: "rejected",
        reason: "Connection request declined by operator",
        timestamp: nowISO(),
      });
      return "processed";
    }
    // decision === true → proceed with acceptance below
  }

  const outcome = await handleConnectionRequest({ /* existing code unchanged */ });
  await this.sendConnectionResult(outcome.peer, outcome.result);
  this.log("info", `Accepted connection request from ${outcome.peer.registrationFile.name} (#${outcome.peer.agentId})`);
  return "processed";
}
```

**CRITICAL:** Also update the two callers that call `processConnectionRequest`:

1. In `onRequest()` (line 1066-1068), change the enqueue callback:
```typescript
this.enqueue(requestKey, async () => {
  const result = await this.processConnectionRequest(envelope.message);
  if (result === "processed") {
    await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
  }
  // If "deferred", do NOT mark completed — stays pending for resolvePending
});
```

2. In `retryPendingConnectionRequests()` (line 1732-1733), change:
```typescript
const result = await this.processConnectionRequest(pendingRequest.message);
if (result === "processed") {
  await this.context.requestJournal.updateStatus(entry.requestId, "completed");
  processed += 1;
}
// If deferred, skip — the hook will re-defer on each retry cycle.
// This is idempotent: no duplicate notifications because emitEvent only fires
// in onRequest (initial receipt), not in retry.
```

- [ ] **Step 5: Export `TapConnectionApprovalContext` from index.ts**

In `packages/core/src/runtime/index.ts`, add to the `service.ts` exports:

```typescript
export {
  // ... existing exports ...
  type TapConnectionApprovalContext,
} from "./service.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/core/test/unit/runtime/service.test.ts -t "defers connection request"`
Expected: PASS

- [ ] **Step 7: Also add a test for approveConnection returning false (rejection)**

```typescript
it("rejects connection request when approveConnection returns false", async () => {
  const approveConnection = vi.fn().mockResolvedValue(false);
  // ... similar setup ...
  // Assert: connection/result with status "rejected" was sent
  // Assert: journal entry marked completed
});
```

- [ ] **Step 8: Run full core tests**

Run: `bun test packages/core/test/unit/runtime/service.test.ts`
Expected: All pass.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/src/runtime/index.ts packages/core/test/unit/runtime/service.test.ts
git commit -m "feat(core): add approveConnection hook to TapMessagingService"
```

---

## Task 4: Extend `resolvePending` for connection requests

**Files:**
- Modify: `packages/core/src/runtime/service.ts:372-413`
- Test: `packages/core/test/unit/runtime/service.test.ts`

- [ ] **Step 1: Write failing test — resolvePending approves a deferred connection request**

```typescript
it("resolves a deferred connection request when approved", async () => {
  const approveConnection = vi.fn().mockResolvedValue(null); // defer initially
  const { service, transport, requestJournal } = await createService({}, {
    hooks: { approveConnection },
  });
  await service.start();

  // Simulate inbound connection/request that gets deferred
  // ... (trigger processConnectionRequest with hook returning null) ...
  await service.drain();

  // Now resolve it
  approveConnection.mockResolvedValue(true); // next time, accept
  const report = await service.resolvePending(requestId, true);

  // Connection result should have been sent
  const resultMsg = transport.sentMessages.find(
    m => m.message.method === "connection/result"
  );
  expect(resultMsg).toBeDefined();
  // Journal entry should be completed
  const entry = await requestJournal.getByRequestId(requestId);
  expect(entry?.status).toBe("completed");
  await service.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/unit/runtime/service.test.ts -t "resolves a deferred connection"`
Expected: FAIL — `resolvePending` throws "Request cannot be resolved manually" for CONNECTION_REQUEST.

- [ ] **Step 3: Extend `resolvePending` to handle CONNECTION_REQUEST**

In `packages/core/src/runtime/service.ts`, modify `resolvePending()`:

```typescript
async resolvePending(requestId: string, approve: boolean): Promise<TapSyncReport> {
  const entry = await this.context.requestJournal.getByRequestId(requestId);
  if (!entry || entry.direction !== "inbound" || entry.kind !== "request") {
    throw new ValidationError(`Pending inbound request not found: ${requestId}`);
  }

  // Remove the old guard that rejects non-ACTION_REQUEST
  if (entry.method !== ACTION_REQUEST && entry.method !== CONNECTION_REQUEST) {
    throw new ValidationError(`Request ${requestId} cannot be resolved manually`);
  }

  // For transfers, use existing decision override mechanism
  if (entry.method === ACTION_REQUEST) {
    this.decisionOverrides.transfers.set(requestId, approve);
  }

  try {
    return await this.executionMutex.runExclusive(
      async () =>
        await this.withTransportSession(async () => {
          await this.drain();
          const latestEntry = await this.context.requestJournal.getByRequestId(requestId);
          if (!latestEntry || latestEntry.direction !== "inbound" || latestEntry.kind !== "request") {
            throw new ValidationError(`Pending inbound request not found: ${requestId}`);
          }
          if (latestEntry.status === "completed") {
            return await this.buildSyncReport(0);
          }

          if (latestEntry.method === ACTION_REQUEST) {
            await this.resolvePendingTransferRequest(latestEntry);
          } else if (latestEntry.method === CONNECTION_REQUEST) {
            await this.resolvePendingConnectionRequest(latestEntry, approve);
          } else {
            throw new ValidationError(`Request ${requestId} cannot be resolved manually`);
          }

          await this.drain();
          return await this.buildSyncReport(1);
        }),
    );
  } finally {
    if (entry.method === ACTION_REQUEST) {
      this.decisionOverrides.transfers.delete(requestId);
    }
  }
}
```

Then add the new private method `resolvePendingConnectionRequest`:

```typescript
private async resolvePendingConnectionRequest(
  entry: RequestJournalEntry,
  approve: boolean,
): Promise<void> {
  const pendingRequest = parsePendingConnectionRequest(entry.metadata);
  if (!pendingRequest) {
    throw new ValidationError(`Cannot parse pending connection request: ${entry.requestId}`);
  }

  if (approve) {
    // Re-process with skipApprovalHook since the user already decided
    await this.processConnectionRequest(pendingRequest.message, { skipApprovalHook: true });
  } else {
    const params = parseConnectionRequest(pendingRequest.message);
    const peer = await this.context.resolver.resolveWithCache(
      params.from.agentId,
      params.from.chain,
    );
    await this.sendConnectionResult(peer, {
      requestId: entry.requestId,
      from: { agentId: this.context.config.agentId, chain: this.context.config.chain },
      status: "rejected",
      reason: "Connection request declined by operator",
      timestamp: nowISO(),
    });
  }
  await this.context.requestJournal.updateStatus(entry.requestId, "completed");
}
```

Note: Uses the `skipApprovalHook` parameter added to `processConnectionRequest` in Task 3 Step 4. This is concurrent-safe (no hook mutation).

- [ ] **Step 4: Run tests to verify the new test passes**

Run: `bun test packages/core/test/unit/runtime/service.test.ts -t "resolves a deferred connection"`
Expected: PASS

- [ ] **Step 5: Also add a test for rejecting a deferred connection request**

- [ ] **Step 6: Run full core tests**

Run: `bun test packages/core/test/unit/runtime/service.test.ts`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/service.ts packages/core/test/unit/runtime/service.test.ts
git commit -m "feat(core): extend resolvePending to handle connection requests"
```

---

## Task 5: Remove `unsafeApproveActions` from OpenClaw plugin config and CLI

**Files:**
- Modify: `packages/openclaw-plugin/src/config.ts`
- Modify: `packages/openclaw-plugin/openclaw.plugin.json`
- Modify: `packages/openclaw-plugin/src/registry.ts:367`
- Modify: `packages/openclaw-plugin/test/config.test.ts`
- Modify: `packages/openclaw-plugin/test/registry.test.ts`
- Modify: `packages/openclaw-plugin/README.md`
- Modify: `OPENCLAW_PLUGIN_DEPLOYMENT_PLAN.md`
- Modify: `packages/cli/src/commands/message-listen.ts`
- Modify: `packages/cli/src/commands/message-sync.ts`
- Modify: `packages/cli/src/lib/tap-service.ts`
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Remove from plugin config type and parsing**

In `packages/openclaw-plugin/src/config.ts`:
- Remove `unsafeApproveActions: boolean` from `TapOpenClawIdentityConfig`
- Remove the `"identities[].unsafeApproveActions"` UI hint
- Remove `unsafeApproveActions: { type: "boolean" }` from JSON schema
- Remove `unsafeApproveActions?: unknown` from the parse input type
- Remove `unsafeApproveActions: input.unsafeApproveActions === true` from `parseIdentityConfig`

- [ ] **Step 2: Remove from plugin JSON schema**

In `packages/openclaw-plugin/openclaw.plugin.json`:
- Remove `"unsafeApproveActions": { "type": "boolean" }` from schema
- Remove the corresponding UI hint entry

- [ ] **Step 3: Remove from registry passthrough**

In `packages/openclaw-plugin/src/registry.ts` line 367:
- Remove `unsafeAutoApproveActions: definition.unsafeApproveActions` from the `TapMessagingService` constructor options

- [ ] **Step 4: Update tests**

In `packages/openclaw-plugin/test/config.test.ts`:
- Remove `unsafeApproveActions: false` from all expected output objects

In `packages/openclaw-plugin/test/registry.test.ts`:
- Remove `unsafeApproveActions: false` from all identity config objects

- [ ] **Step 5: Remove from CLI**

In `packages/cli/src/commands/message-listen.ts`:
- Remove `unsafeApproveActions` from `cmdOpts` type and the option passthrough

In `packages/cli/src/commands/message-sync.ts`:
- Remove `unsafeApproveActions` from `cmdOpts` type and the option passthrough

In `packages/cli/src/lib/tap-service.ts`:
- Remove `unsafeAutoApproveActions` from the options interface and passthrough

In `packages/cli/src/cli.ts`:
- Remove the `--unsafe-approve-actions` flag definition from the listen and sync commands
- Remove `unsafeApproveActions: cmdOpts.unsafeApproveActions` from the action handlers

- [ ] **Step 6: Update docs**

In `packages/openclaw-plugin/README.md` and `OPENCLAW_PLUGIN_DEPLOYMENT_PLAN.md`:
- Remove `"unsafeApproveActions": false` from example config JSON

- [ ] **Step 7: Run typecheck and all tests**

Run: `bun run typecheck && bun run test`
Expected: All pass. No remaining references to `unsafeApproveActions`/`unsafeAutoApproveActions`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove unsafeApproveActions from plugin config and CLI"
```

---

## Task 6: Create `notification-queue.ts`

**Files:**
- Create: `packages/openclaw-plugin/src/notification-queue.ts`
- Create: `packages/openclaw-plugin/test/notification-queue.test.ts`

- [ ] **Step 1: Write tests for the notification queue**

Create `packages/openclaw-plugin/test/notification-queue.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { TapNotificationQueue, type TapNotification } from "../src/notification-queue.js";

function makeNotification(overrides: Partial<TapNotification> = {}): TapNotification {
  return {
    type: "summary",
    identity: "default",
    timestamp: "2026-03-18T00:00:00.000Z",
    method: "message/send",
    from: 10,
    fromName: "Agent Y",
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    detail: {},
    oneLiner: "Test notification",
    ...overrides,
  };
}

describe("TapNotificationQueue", () => {
  it("push and drain returns notifications in order", () => {
    const queue = new TapNotificationQueue();
    const n1 = makeNotification({ messageId: "1" });
    const n2 = makeNotification({ messageId: "2" });
    queue.push(n1);
    queue.push(n2);

    const drained = queue.drain();
    expect(drained).toEqual([n1, n2]);
    expect(queue.drain()).toEqual([]); // empty after drain
  });

  it("peek returns without clearing", () => {
    const queue = new TapNotificationQueue();
    queue.push(makeNotification());
    expect(queue.peek()).toHaveLength(1);
    expect(queue.peek()).toHaveLength(1); // still there
  });

  it("upgrade changes type and merges updates", () => {
    const queue = new TapNotificationQueue();
    queue.push(makeNotification({ messageId: "abc", type: "escalation" }));
    queue.upgrade("abc", "summary", { oneLiner: "Approved 5 USDC" });

    const [n] = queue.drain();
    expect(n.type).toBe("summary");
    expect(n.oneLiner).toBe("Approved 5 USDC");
  });

  it("upgrade is a no-op for unknown messageId", () => {
    const queue = new TapNotificationQueue();
    queue.push(makeNotification({ messageId: "abc" }));
    queue.upgrade("unknown", "summary"); // no crash
    expect(queue.drain()[0].type).toBe("summary"); // unchanged
  });

  it("evicts oldest info items first when at capacity", () => {
    const queue = new TapNotificationQueue(5); // small max for testing
    queue.push(makeNotification({ messageId: "info-1", type: "info" }));
    queue.push(makeNotification({ messageId: "info-2", type: "info" }));
    queue.push(makeNotification({ messageId: "esc-1", type: "escalation" }));
    queue.push(makeNotification({ messageId: "sum-1", type: "summary" }));
    queue.push(makeNotification({ messageId: "sum-2", type: "summary" }));

    // At capacity. Next push should evict oldest info.
    queue.push(makeNotification({ messageId: "new-1", type: "summary" }));

    const drained = queue.drain();
    expect(drained).toHaveLength(5);
    expect(drained.find((n) => n.messageId === "info-1")).toBeUndefined(); // evicted
    expect(drained.find((n) => n.messageId === "esc-1")).toBeDefined(); // never evicted
  });

  it("never evicts escalation items", () => {
    const queue = new TapNotificationQueue(3);
    queue.push(makeNotification({ messageId: "esc-1", type: "escalation" }));
    queue.push(makeNotification({ messageId: "esc-2", type: "escalation" }));
    queue.push(makeNotification({ messageId: "esc-3", type: "escalation" }));

    // All escalations, at capacity. Push should still add (exceeds max for escalations).
    queue.push(makeNotification({ messageId: "esc-4", type: "escalation" }));
    expect(queue.drain()).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/openclaw-plugin/test/notification-queue.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `notification-queue.ts`**

Create `packages/openclaw-plugin/src/notification-queue.ts`:

```typescript
export interface TapNotification {
  type: "summary" | "escalation" | "info";
  identity: string;
  timestamp: string;
  method: string;
  from: number;
  fromName?: string;
  messageId: string;
  requestId?: string;
  detail: Record<string, unknown>;
  oneLiner: string;
}

const DEFAULT_MAX_SIZE = 1000;
const EVICTION_PRIORITY: TapNotification["type"][] = ["info", "summary"];

export class TapNotificationQueue {
  private readonly items: TapNotification[] = [];
  private readonly maxSize: number;

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  push(notification: TapNotification): void {
    this.items.push(notification);
    this.evictIfNeeded();
  }

  upgrade(
    messageId: string,
    newType: TapNotification["type"],
    updates?: Partial<Pick<TapNotification, "oneLiner" | "detail" | "requestId">>,
  ): void {
    const item = this.items.find((n) => n.messageId === messageId);
    if (!item) return;
    item.type = newType;
    if (updates) {
      if (updates.oneLiner !== undefined) item.oneLiner = updates.oneLiner;
      if (updates.detail !== undefined) item.detail = updates.detail;
      if (updates.requestId !== undefined) item.requestId = updates.requestId;
    }
  }

  drain(): TapNotification[] {
    return this.items.splice(0);
  }

  peek(): TapNotification[] {
    return [...this.items];
  }

  private evictIfNeeded(): void {
    if (this.items.length <= this.maxSize) return;

    for (const evictType of EVICTION_PRIORITY) {
      const index = this.items.findIndex((n) => n.type === evictType);
      if (index !== -1) {
        this.items.splice(index, 1);
        return;
      }
    }
    // Only escalations remain — allow overflow
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/openclaw-plugin/test/notification-queue.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/openclaw-plugin/src/notification-queue.ts packages/openclaw-plugin/test/notification-queue.test.ts
git commit -m "feat(openclaw-plugin): add TapNotificationQueue"
```

---

## Task 7: Create `event-classifier.ts`

**Files:**
- Create: `packages/openclaw-plugin/src/event-classifier.ts`
- Create: `packages/openclaw-plugin/test/event-classifier.test.ts`

- [ ] **Step 1: Write tests for the event classifier**

Create `packages/openclaw-plugin/test/event-classifier.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { classifyTapEvent } from "../src/event-classifier.js";

describe("classifyTapEvent", () => {
  it("drops duplicate events", () => {
    expect(classifyTapEvent({ direction: "incoming", from: 10, method: "message/send", id: "1", receipt_status: "duplicate" })).toBeNull();
  });

  it("classifies message/send as auto-handle", () => {
    const result = classifyTapEvent({ direction: "incoming", from: 10, method: "message/send", id: "1", receipt_status: "received" });
    expect(result).toBe("auto-handle");
  });

  it("classifies action/result as auto-handle", () => {
    const result = classifyTapEvent({ direction: "incoming", from: 10, method: "action/result", id: "1", receipt_status: "received" });
    expect(result).toBe("auto-handle");
  });

  it("classifies permissions/update as auto-handle", () => {
    const result = classifyTapEvent({ direction: "incoming", from: 10, method: "permissions/update", id: "1", receipt_status: "received" });
    expect(result).toBe("auto-handle");
  });

  it("classifies connection/request as escalate", () => {
    const result = classifyTapEvent({ direction: "incoming", from: 10, method: "connection/request", id: "1", receipt_status: "queued" });
    expect(result).toBe("escalate");
  });

  it("classifies action/request with receipt_status queued as escalate (transfer)", () => {
    const result = classifyTapEvent({ direction: "incoming", from: 10, method: "action/request", id: "1", receipt_status: "queued" });
    expect(result).toBe("escalate");
  });

  it("classifies action/request with receipt_status received as auto-handle (permission grant request)", () => {
    const result = classifyTapEvent({ direction: "incoming", from: 10, method: "action/request", id: "1", receipt_status: "received" });
    expect(result).toBe("auto-handle");
  });

  it("classifies connection/result as notify", () => {
    const result = classifyTapEvent({ direction: "incoming", from: 10, method: "connection/result", id: "1", receipt_status: "received" });
    expect(result).toBe("notify");
  });

  it("returns null for outgoing events", () => {
    expect(classifyTapEvent({ direction: "outgoing", from: 10, method: "message/send", id: "1", receipt_status: "received" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/openclaw-plugin/test/event-classifier.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `event-classifier.ts`**

Create `packages/openclaw-plugin/src/event-classifier.ts`:

```typescript
export interface TapEmitEventPayload {
  direction: string;
  from: number;
  method: string;
  id: string | number;
  receipt_status: string;
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
      return "escalate";

    case "action/request":
      // receipt_status "received" = permission grant request (already handled synchronously)
      // receipt_status "queued" = transfer request (pending async processing)
      return event.receipt_status === "received" ? "auto-handle" : "escalate";

    case "connection/result":
      return "notify";

    default:
      return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/openclaw-plugin/test/event-classifier.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/openclaw-plugin/src/event-classifier.ts packages/openclaw-plugin/test/event-classifier.test.ts
git commit -m "feat(openclaw-plugin): add TapEvent classifier"
```

---

## Task 8: Wire hooks in `registry.ts`

**Files:**
- Modify: `packages/openclaw-plugin/src/registry.ts`
- Modify: `packages/openclaw-plugin/test/registry.test.ts`

This is the integration point. The registry needs to:
1. Accept a reference to the OpenClaw plugin runtime (for `requestHeartbeatNow` and `enqueueSystemEvent`)
2. Create a `TapNotificationQueue` per identity
3. Wire `emitEvent`, `approveTransfer`, and `approveConnection` hooks
4. Expose the queues so `plugin.ts` can drain them in the `before_prompt_build` hook

- [ ] **Step 1: Update `OpenClawTapRegistry` constructor to accept runtime**

Add a `runtime` parameter and a per-identity notification queue map:

```typescript
import { type TapEmitEventPayload, classifyTapEvent } from "./event-classifier.js";
import { TapNotificationQueue, type TapNotification } from "./notification-queue.js";
// Import heartbeat and system event functions from openclaw/plugin-sdk.
// These are exported from openclaw/plugin-sdk/infra/heartbeat-wake and
// openclaw/plugin-sdk/infra/system-events respectively.
// Verify the barrel re-export path at implementation time — may need:
//   import { requestHeartbeatNow } from "openclaw/plugin-sdk/infra/heartbeat-wake";
//   import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra/system-events";
// Or the barrel may re-export them:
import { requestHeartbeatNow } from "openclaw/plugin-sdk";
import { enqueueSystemEvent } from "openclaw/plugin-sdk";

export class OpenClawTapRegistry {
  private readonly runtimes = new Map<string, ManagedTapRuntime>();
  private readonly notificationQueues = new Map<string, TapNotificationQueue>();
  // ... existing fields ...

  constructor(
    private readonly pluginConfig: TapOpenClawPluginConfig,
    private readonly logger: PluginLogger,
  ) {}
  // ...
```

- [ ] **Step 2: Create notification queue per identity in `ensureRuntime`**

In `ensureRuntime()`, create a queue and wire the hooks:

```typescript
private async ensureRuntime(name: string): Promise<ManagedTapRuntime> {
  // ... existing lookup ...

  const notificationQueue = new TapNotificationQueue();
  this.notificationQueues.set(name, notificationQueue);

  const service = new TapMessagingService(context, {
    ownerLabel: `openclaw:${definition.name}`,
    hooks: {
      executeTransfer: async (serviceConfig, request) =>
        await executeOnchainTransfer(serviceConfig, request),
      log: (level, message) => {
        logWithLevel(this.logger, level, `[trusted-agents-tap:${definition.name}] ${message}`);
      },
      emitEvent: (payload) => {
        this.handleEmitEvent(name, notificationQueue, payload as TapEmitEventPayload);
      },
      approveTransfer: async ({ requestId, contact, request, activeTransferGrants }) => {
        if (activeTransferGrants.length > 0) {
          notificationQueue.upgrade(requestId, "summary", {
            oneLiner: `Approved ${request.amount} ${request.asset} transfer to ${contact.peerDisplayName} (covered by grant)`,
          });
          return true;
        }
        return null;
      },
      approveConnection: async ({ peerAgentId, peerName }) => {
        return null; // Always escalate to user
      },
    },
  });
  // ... rest of ensureRuntime ...
}
```

- [ ] **Step 3: Implement `handleEmitEvent` method**

```typescript
private handleEmitEvent(
  identity: string,
  queue: TapNotificationQueue,
  payload: TapEmitEventPayload,
): void {
  const bucket = classifyTapEvent(payload);
  if (bucket === null) return;

  const notification: TapNotification = {
    type: bucket === "auto-handle" ? "summary" : bucket === "escalate" ? "escalation" : "info",
    identity,
    timestamp: (payload.timestamp as string) ?? new Date().toISOString(),
    method: payload.method,
    from: payload.from,
    messageId: String(payload.id),
    detail: payload,
    oneLiner: this.buildOneLiner(payload),
  };

  queue.push(notification);

  if (bucket === "escalate") {
    // sessionKey "agent:main:main" is the default main agent session.
    // At implementation time, verify this is correct for your Gateway setup.
    // If the SDK provides a way to get the active session key from plugin context,
    // prefer that over hardcoding.
    enqueueSystemEvent(
      `TAP: Incoming ${payload.method} from agent #${payload.from} requires attention`,
      { sessionKey: "agent:main:main" },
    );
    requestHeartbeatNow({
      reason: "tap-escalation",
      coalesceMs: 2000,
    });
  }
}

private buildOneLiner(payload: TapEmitEventPayload): string {
  // Basic one-liner from the event payload. Hooks can upgrade with richer text later.
  switch (payload.method) {
    case "message/send":
      return `Received message from agent #${payload.from}`;
    case "action/result":
      return `Action result received from agent #${payload.from}`;
    case "permissions/update":
      return `Grant update from agent #${payload.from}`;
    case "connection/request":
      return `Connection request from agent #${payload.from}`;
    case "connection/result":
      return `Connection confirmed with agent #${payload.from}`;
    case "action/request":
      return `Action request from agent #${payload.from}`;
    default:
      return `TAP event: ${payload.method} from agent #${payload.from}`;
  }
}
```

- [ ] **Step 4: Add `drainNotifications` method for plugin.ts to call**

```typescript
drainNotifications(): TapNotification[] {
  const all: TapNotification[] = [];
  for (const queue of this.notificationQueues.values()) {
    all.push(...queue.drain());
  }
  return all;
}
```

- [ ] **Step 5: Update registry tests**

Remove `unsafeApproveActions` from all test fixtures. Add a basic test that verifying the notification queue exists after runtime creation (if testable — the existing tests mock `ensureRuntime`, so this may be better tested as integration).

- [ ] **Step 6: Run typecheck and tests**

Run: `bun run typecheck && bun test packages/openclaw-plugin/test/`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add packages/openclaw-plugin/src/registry.ts packages/openclaw-plugin/test/registry.test.ts
git commit -m "feat(openclaw-plugin): wire emitEvent, approveTransfer, approveConnection hooks in registry"
```

---

## Task 9: Register `before_prompt_build` hook in `plugin.ts`

**Files:**
- Modify: `packages/openclaw-plugin/src/plugin.ts`

- [ ] **Step 1: Update plugin.ts to register the before_prompt_build hook**

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseTapOpenClawPluginConfig, tapOpenClawPluginConfigSchema } from "./config.js";
import { OpenClawTapRegistry } from "./registry.js";
import { createTapGatewayTool } from "./tool.js";

const plugin = {
  id: "trusted-agents-tap",
  name: "Trusted Agents TAP",
  description:
    "Run the Trusted Agents Protocol inside OpenClaw Gateway with a background TAP runtime and TAP Gateway tool.",
  configSchema: tapOpenClawPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const pluginConfig = parseTapOpenClawPluginConfig(api.pluginConfig);
    const registry = new OpenClawTapRegistry(pluginConfig, api.logger);

    api.registerService({
      id: "trusted-agents-tap-runtime",
      start: async () => {
        await registry.start();
      },
      stop: async () => {
        await registry.stop();
      },
    });

    api.registerTool(createTapGatewayTool(registry));

    api.on("before_prompt_build", async (_event, _ctx) => {
      const notifications = registry.drainNotifications();
      if (notifications.length === 0) return;

      const lines = notifications.map((n) => {
        const prefix =
          n.type === "escalation" ? "ESCALATION" : n.type === "summary" ? "SUMMARY" : "INFO";
        return `- ${prefix}: ${n.oneLiner}`;
      });

      return {
        prependContext: `[TAP Notifications]\n${lines.join("\n")}`,
      };
    });
  },
};

export default plugin;
```

Note: Use `api.on(hookName, handler)` — this is the correct plugin API for hook registration. `registerTypedHook` is an internal function on the plugin registry, not exposed on `OpenClawPluginApi`.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS. The `registerTypedHook` call should type-check with the `"before_prompt_build"` hook name.

- [ ] **Step 3: Run all tests**

Run: `bun run test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add packages/openclaw-plugin/src/plugin.ts
git commit -m "feat(openclaw-plugin): register before_prompt_build hook for TAP notifications"
```

---

## Task 10: Update skill docs

**Files:**
- Modify: `packages/openclaw-plugin/skills/trusted-agents-openclaw/SKILL.md`

- [ ] **Step 1: Update the OpenClaw SKILL.md**

Add a new section after the "Decision Rule" section:

```markdown
## Inbound Message Notifications

The TAP plugin notifies the agent in real time when messages arrive via XMTP:

- **Escalations** wake the agent immediately (via heartbeat) for decisions:
  - Connection requests — always require user approval
  - Transfer requests not covered by grants — need explicit approval
  - Use `tap_gateway resolve_pending` with `requestId` and `approve: true/false` to resolve

- **Summaries** appear in the next agent turn as one-liners:
  - Messages from connected peers
  - Auto-approved transfers (covered by standing grants)
  - Grant updates and permission requests from peers

- **Info** items are purely informational:
  - Connection confirmations

No polling required. The plugin's streaming listener handles delivery automatically.
```

Also update the "connect" action description to note that inbound connection requests now require user approval:

```markdown
- **connect**: Send an asynchronous trust request using an invite URL. Params: `inviteUrl` (required). Inbound connection requests from peers are deferred for user approval — they appear as escalation notifications.
```

- [ ] **Step 2: Update generic TAP skill docs to remove `--unsafe-approve-actions` references**

In `packages/sdk/skills/trusted-agents/messaging/SKILL.md`, remove all references to the `--unsafe-approve-actions` flag from command syntax and descriptions.

- [ ] **Step 3: Commit**

```bash
git add packages/openclaw-plugin/skills/trusted-agents-openclaw/SKILL.md packages/sdk/skills/trusted-agents/messaging/SKILL.md
git commit -m "docs: document inbound notification behavior and remove unsafe-approve-actions from skills"
```

---

## Task 11: Lint, typecheck, full test pass

- [ ] **Step 1: Run lint**

Run: `bun run lint`
Expected: PASS. Fix any issues.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS. Fix any issues.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: All pass.

- [ ] **Step 4: Fix any failures, then commit**

```bash
git add -A
git commit -m "chore: fix lint and type issues"
```

(Only commit if there were fixes needed.)

---

## Task 12: Update E2E test if needed

**Files:**
- Check: `packages/cli/test/e2e-two-agent-flow.test.ts`

Per `CLAUDE.md`, the E2E test must be updated when there are meaningful behavioral changes to the two-agent flow. Removing `unsafeAutoApproveActions` is a meaningful change if the E2E test uses it.

- [ ] **Step 1: Check if E2E test references `unsafeApproveActions` or `unsafeAutoApproveActions`**

Search the file. If it uses the flag, update to use an `approveTransfer` hook or remove the flag. If it doesn't reference it, no changes needed.

- [ ] **Step 2: Run the E2E test**

Run: `bun test packages/cli/test/e2e-two-agent-flow.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit if changes were needed**

```bash
git add packages/cli/test/e2e-two-agent-flow.test.ts
git commit -m "test: update E2E two-agent flow for approveTransfer hook"
```
