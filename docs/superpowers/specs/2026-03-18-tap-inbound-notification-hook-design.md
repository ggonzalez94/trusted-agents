# TAP Inbound Message Notification Hook for OpenClaw Plugin

## Problem

When the TAP OpenClaw plugin receives a message via XMTP streaming, it stores it but does not notify the agent session. The agent only discovers new messages when it actively polls (`tap_gateway sync`). This causes minutes of latency in agent-to-agent conversations.

## Goal

When an inbound TAP message or action request arrives, the plugin classifies it, auto-handles what it can (via grants), and wakes the agent session for anything that needs user attention — all in near real-time.

## Design Decisions

- **Event-driven agent wake** is the primary delivery mechanism: `enqueueSystemEvent()` + `requestHeartbeatNow()` + `before_prompt_build` hook.
- **No channel fallback** for offline users in this iteration. Escalations queue until the next agent interaction.
- **Grant-based transfer approval** replaces the `unsafeApproveActions` toggle, which is removed entirely.
- **Connection requests always escalate** to the user — trust establishment is a human decision. This requires a new `approveConnection` hook in core since the current `processConnectionRequest()` auto-accepts valid invites.
- **Auto-handled events surface as one-liner summaries** in the agent's next turn, expandable for details.
- **The notification queue is in-memory**, not file-based. On restart, `syncOnce()` reprocesses missed messages from XMTP, so nothing is lost.

## Event Classification

A pure function in the plugin classifies each inbound TAP event into one of three buckets based on the `method` field from the `emitEvent` payload. The `receipt_status: "duplicate"` events are dropped before classification.

### Auto-handle

The agent processes silently and surfaces a one-liner summary in its next turn.

| Method | Condition | Example one-liner |
|--------|-----------|-------------------|
| `message/send` | From a connected peer | "Received message from Agent Y: 'Delivery confirmed for order #789'" |
| `action/result` | Response to an outbound request we initiated | "Agent Y completed your 5 USDC transfer request" |
| `permissions/update` | Grant updates from peers | "Agent Y updated their grants: transfer/request up to 10 USDC" |

Note: `action/request` events that are auto-approved by grants also appear as summaries, but this is determined by the `approveTransfer` hook during async processing — not by the classifier at emit-time. See "Classification Timing" below.

### Escalate

The plugin wakes the agent immediately. The agent asks the user for a decision.

| Method | Condition |
|--------|-----------|
| `connection/request` | Always (method-based, ignores `receipt_status`) — requires new `approveConnection` hook in core |
| `action/request` | All sub-types start as preliminary escalation. Async hooks may upgrade to summary. |

### Notify-only

Informational. Queued for the agent's next turn, no wake triggered.

| Method | Condition |
|--------|-----------|
| `connection/result` | Confirmation of a connection we initiated |
| Duplicates | `receipt_status: "duplicate"` — silently dropped, not queued |

Note: `connection/revoke` exists as a protocol method but is not currently handled by `TapMessagingService` or `XmtpTransport`. No events will be emitted for it. When `connection/revoke` handling is implemented in core in the future, it should be classified as notify-only.

### Classification Timing

The classifier runs inside the `emitEvent` callback, which fires synchronously when the message is received. For most event types (`message/send`, `connection/request`, `connection/result`, `permissions/update`, `action/result`), the `method` field alone determines the bucket — no async context needed.

For `action/request`, the classifier **cannot** distinguish sub-types (transfer vs permission-grant-request) or determine grant coverage at emit-time, because:
1. The `emitEvent` payload is `{ direction, from, method, id, receipt_status }` for both sub-types — no sub-type field.
2. Grant evaluation happens in async queue processing, after `emitEvent` fires.

Therefore, the classifier treats **all** `action/request` events as preliminary escalations. During async processing, the appropriate hook (`approveTransfer` for transfers, or the existing `handlePermissionGrantRequest` for grant requests) determines the final outcome and upgrades the notification:

- **Transfer requests:** `approveTransfer` hook fires. If grants cover it → upgrade to summary. If not → stays as escalation.
- **Permission grant requests:** Processed immediately by `handlePermissionGrantRequest`. The `emitEvent` for these fires with `receipt_status: "received"` (not "queued"), so the classifier can use this signal: `action/request` with `receipt_status: "received"` → upgrade to summary (permission grant request, already handled). `action/request` with `receipt_status: "queued"` → stays as preliminary escalation (transfer request, pending async processing).

This means the notification queue needs an `upgrade(id, newType)` operation for the transfer auto-approval case.

### One-Liner Data Source

The `emitEvent` payload contains only `{ direction, from, method, id, receipt_status }` — not enough for meaningful one-liner summaries. The classifier generates one-liners by looking up context from the trust store and conversation log:

- **`message/send`**: Read the latest conversation log entry for the sender to get message text.
- **`permissions/update`**: Read the contact's updated grants from the trust store.
- **`action/result`**: Read the request journal entry for the corresponding outbound request.
- **`action/request`** (when upgraded to summary by `approveTransfer`): The hook itself generates the one-liner since it has the full `TapTransferApprovalContext`.
- **`connection/request`**: The hook has `peerName` and `peerAgentId` from the `approveConnection` context.
- **`connection/result`**: Read the contact record from the trust store by sender `agentId`.

## Event Pipeline

```
XMTP stream → XmtpTransport.processMessage()
  → TapMessagingService.onRequest/onResult()
    → emitEvent() hook (wired in plugin)
      → EventClassifier.classify(event)
        ├─ auto-handle → NotificationQueue.push({ type: "summary", ... })
        ├─ escalate   → NotificationQueue.push({ type: "escalation", ... })
        │                + runtime.system.enqueueSystemEvent("tap:escalation")
        │                + runtime.system.requestHeartbeatNow()
        └─ notify     → NotificationQueue.push({ type: "info", ... })

For transfer action/request specifically:
  emitEvent fires → push preliminary "escalation" to queue
  ... later, async queue processes the transfer ...
  → approveTransfer hook fires
    ├─ grant covers it → return true → hook notifies queue to upgrade to "summary"
    └─ no grant        → return null → escalation stays, agent must resolve
```

On the agent's next turn:

```
before_prompt_build hook fires
  → NotificationQueue.drain()
  → If non-empty: inject [TAP Notifications] system context block
  → Agent sees notifications and acts accordingly
```

### Injected Context Format

```
[TAP Notifications]
- ESCALATION: Agent X (id:42) is requesting 50 USDC transfer. No grant covers this. Use tap_gateway resolve_pending to approve or reject (requestId: "req_abc123").
- ESCALATION: Agent Z (id:7) wants to connect. Use tap_gateway resolve_pending to accept or decline.
- SUMMARY: Approved 5 USDC transfer to Agent Y (covered by grant).
- SUMMARY: Received message from Agent Y: "Delivery confirmed for order #789"
- SUMMARY: Agent Y updated their grants: transfer/request up to 10 USDC.
- INFO: Connection with Agent Z is now active.
```

Escalations require action. Summaries and info are awareness only.

## Core Changes Required

### 1. Remove `unsafeAutoApproveActions`

Remove the `unsafeAutoApproveActions` option from `TapServiceOptions` and its usage in `decideTransfer()` (service.ts line 1664-1670).

### 2. Change `decideTransfer` to call `approveTransfer` hook even when no grants match

Currently, `decideTransfer()` hard-rejects (`return false`) when `transferGrants.length === 0` (service.ts line 1672-1678). This prevents the `approveTransfer` hook from ever being called for ungrantable requests, which blocks the escalation flow.

**Change:** When `transferGrants.length === 0` and an `approveTransfer` hook is registered, call the hook with an empty `activeTransferGrants` array instead of hard-rejecting. If no hook is registered, preserve the current behavior (reject).

```typescript
// Before:
if (transferGrants.length === 0) {
  this.log("warn", `Rejecting action request...`);
  return false;
}

// After:
if (transferGrants.length === 0) {
  if (this.hooks.approveTransfer) {
    // Let the hook decide — it can return null to leave pending
    return (await this.hooks.approveTransfer({
      requestId,
      contact,
      request,
      activeTransferGrants: transferGrants,
      ledgerPath: getPermissionLedgerPath(this.context.config.dataDir),
    })) ?? null;
  }
  this.log("warn", `Rejecting action request...`);
  return false;
}
```

This is backward-compatible: existing callers that don't wire `approveTransfer` get the same reject behavior.

### 3. Add `approveConnection` hook

Currently `processConnectionRequest()` (service.ts line 1238) auto-accepts valid connection requests. For the "always escalate connection requests" design, we need a new hook:

```typescript
// Addition to TapServiceHooks:
approveConnection?: (context: {
  peerAgentId: number;
  peerName: string;
  peerChain: string;
}) => Promise<boolean | null>;
```

In `processConnectionRequest()`, after invite validation passes but before calling `handleConnectionRequest()`:
- If `approveConnection` hook is registered, call it.
- If it returns `true` → proceed with acceptance (current behavior).
- If it returns `false` → send rejection result.
- If it returns `null` → leave the request pending in the journal. Don't send a result yet. The agent escalates to the user.

When the user decides (via `tap_gateway resolve_pending`), the pending connection request is retried and processed. This requires extending `resolvePending` in core — see core change 5 below.

## Grant-Aware Approval Hook

The plugin wires an `approveTransfer` hook into `TapMessagingService`:

```typescript
approveTransfer: async ({ requestId, contact, request, activeTransferGrants }) => {
  if (activeTransferGrants.length > 0) {
    // Grant covers it — auto-approve and upgrade notification to summary
    // requestId is the journal entry ID which corresponds to envelope.message.id (the messageId in the queue)
    notificationQueue.upgrade(requestId, "summary", {
      oneLiner: `Approved ${request.amount} ${request.asset} transfer to ${contact.peerDisplayName} (covered by grant)`,
    });
    return true;
  }
  // No grant — leave pending for escalation (notification already queued by emitEvent)
  return null;
}
```

The existing `findApplicableTransferGrants()` (service.ts line 2222) handles the grant matching before the hook is called. The hook receives `activeTransferGrants` already filtered. With the core change above, this hook is now also called when the array is empty.

## Connection Approval Hook

The plugin wires the new `approveConnection` hook:

```typescript
approveConnection: async ({ peerAgentId, peerName }) => {
  // Always escalate — return null to leave pending
  return null;
}
```

The escalation notification was already pushed by `emitEvent`. The agent wakes, asks the user, and resolves via `tap_gateway resolve_pending`.

## Notification Queue

An in-memory per-identity structure in the plugin.

```typescript
interface TapNotification {
  type: "summary" | "escalation" | "info";
  identity: string;
  timestamp: string;
  method: string;
  from: number;       // agentId
  fromName?: string;  // peer name from contacts
  messageId: string;  // JSON-RPC message id from emitEvent payload (envelope.message.id)
  requestId?: string; // journal request ID, set during async processing for action/request
  detail: Record<string, unknown>;  // method-specific payload
  oneLiner: string;   // human-readable summary
}
```

The `messageId` field (from the `emitEvent` payload `id`) is the canonical key for push and upgrade operations. Both the `emitEvent` callback and the `approveTransfer`/`approveConnection` hooks can reference the same `messageId` to correlate entries.

Operations:
- `push(notification)` — add a classified event
- `upgrade(messageId, newType, updates?)` — change type and update fields (used when approveTransfer auto-approves after emitEvent already queued an escalation)
- `drain(): TapNotification[]` — return all pending and clear
- `peek(): TapNotification[]` — return pending without clearing

In-memory because the plugin process owns the lifecycle. On restart, `syncOnce()` reprocesses from XMTP — no data loss.

Maximum queue size: 1000 entries. If the queue overflows (agent offline for a long time), oldest notify-only items are evicted first, then oldest summaries. Escalations are never evicted.

## Changes by Package

### `packages/core`

1. Remove `unsafeAutoApproveActions` from `TapServiceOptions` and its usage in `decideTransfer()`.
2. Change `decideTransfer()` to call `approveTransfer` hook when `transferGrants.length === 0` and a hook is registered, instead of hard-rejecting.
3. Add `approveConnection` hook to `TapServiceHooks`.
4. Update `processConnectionRequest()` to call `approveConnection` hook after invite validation, deferring the request when hook returns `null`.
5. Extend `resolvePending()` to handle pending connection requests. Currently `resolvePending()` (service.ts) rejects any entry whose method is not `ACTION_REQUEST`. It must also accept `CONNECTION_REQUEST` entries: when approved, retry `processConnectionRequest()` (which will now skip the `approveConnection` hook since the user already decided); when rejected, send a `connection/result` with status "rejected".
6. Update tests for the changed `decideTransfer`, new `approveConnection`, and extended `resolvePending` behavior.

### `packages/openclaw-plugin`

1. **`config.ts`** — Remove `unsafeApproveActions` from `TapOpenClawIdentityConfig`, JSON schema, UI hints, and parsing.
2. **`event-classifier.ts`** (new) — Pure function: `classify(event) → "auto-handle" | "escalate" | "notify"`. Classification is based on `method` and `receipt_status` fields only. For `action/request` (transfer), defaults to escalation; the `approveTransfer` hook upgrades to summary if a grant covers it.
3. **`notification-queue.ts`** (new) — In-memory per-identity queue. `push`, `upgrade`, `drain`, `peek`. Max 1000 entries with eviction policy.
4. **`registry.ts`** — Wire new hooks when constructing `TapMessagingService`:
   - `emitEvent` → classify event, push to notification queue, enqueue system event + heartbeat for escalations.
   - `approveTransfer` → grant-aware: auto-approve if grants cover it (upgrade notification to summary), return `null` otherwise.
   - `approveConnection` → always return `null` (escalate to user).
   - Remove `unsafeApproveActions` passthrough.
5. **`plugin.ts`** — Register `before_prompt_build` hook via `api.on("before_prompt_build", handler)`. The hook drains the notification queue and injects a `[TAP Notifications]` system context block into the agent's turn.

### `packages/cli`

- Remove any `unsafeAutoApproveActions` references in shared types if they exist.
- No behavioral changes. CLI does not wire the new `approveConnection` hook (existing auto-accept behavior is preserved for CLI users).

### `packages/sdk/skills/trusted-agents/`

- Update skill docs to reflect new notification behavior.

### `packages/openclaw-plugin/skills/trusted-agents-openclaw/`

- Update OpenClaw-specific skill docs to describe auto-triage, escalation surfacing, and grant-based approval.

## What This Does NOT Change

- The `tap_gateway` tool actions — existing actions (`resolve_pending`, `list_pending`, `sync`, etc.) already cover what the agent needs. The `resolve_pending` action will work for both transfer and connection escalations after the core `resolvePending` extension.
- XMTP transport or stream listener behavior.
- File-based persistence (trust store, request journal, conversation logs).
- CLI behavior outside of removing the `unsafeApproveActions` option (CLI preserves auto-accept for connections).
- The periodic reconcile interval — it remains as a safety net, not the primary delivery path.

## Open Questions

1. **`enqueueSystemEvent` + `requestHeartbeatNow` behavior** needs validation against the actual OpenClaw runtime. The design assumes these trigger an agent turn where `before_prompt_build` fires. If not, we need an alternative wake mechanism.
2. **`before_prompt_build` hook registration** — the current `plugin.ts` only uses `api.registerService()` and `api.registerTool()`. The `api.on("before_prompt_build", handler)` pattern needs validation. The SDK exposes both `api.on()` and `api.registerHook()` — confirm which is the correct registration pattern.
