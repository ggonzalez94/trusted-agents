# TAP Connection Flow Simplification — Design

**Status:** Approved for implementation
**Date:** 2026-04-10
**Scope:** R1–R6 from the invite + connection flow review. R7 (registration schema change) explicitly deferred.

## Background

The current `tap invite` / `tap connect` flow exchanges only 2 XMTP messages on the happy path, which is already the minimum for a request/response handshake. The complexity users hit is not on the wire — it is in local state choreography:

- Three files track one logical "pending connection": `pending-connects.json`, `request-journal.json`, and (when the transport is owned by another process) `tap-commands-outbox.json`.
- `tap connect` is falsely synchronous — it waits only for the XMTP delivery receipt, not the peer's `connection/result`, and always returns `status: "pending"` unless the caller happens to be running a listener. `--wait-seconds` papers over this with polling.
- The inviter writes the contact as `active` *before* confirming `connection/result` delivery. A send failure leaves Alice connected while Bob has no record; the retry code that exists today is papering over the ordering.
- `request-journal.json` has a dead `acked` state and no explicit `queued` state for intents that have not yet touched the wire.
- `approveConnection` deferrals sit in `pending` indistinguishably from in-flight work; operators have no clean way to list "things waiting on me."

This spec eliminates the duplicate state, makes `tap connect` actually synchronous, fixes the ordering, and collapses the state machine.

## Goals

1. One source of truth per logical operation. No cross-file invariants to maintain.
2. `tap connect` either returns `active` or a clean error/`pending` within a bounded time. Never misleading.
3. Alice cannot end up in a state where she thinks Bob is a contact but Bob never got the result.
4. Minimum viable state machine. Every state must justify itself by recovery behavior.
5. Remove technical debt as part of the change — delete dead code paths, delete unused files, delete the old data structures. No compatibility shims, no rename churn.

## Non-goals

- R7: replacing `xmtp.endpoint` with `xmtpInboxId` in the registration file. This is a wire schema change and deserves its own spec.
- Transport-layer retry policies beyond "reconcile via sync on next run".
- Multi-agent-per-process support.
- Changes to how XMTP receipts work at the transport layer.

## Scope constraint — remove technical debt

Per user directive, this change must actively simplify rather than accumulate. Specifically:

- `FilePendingConnectStore` and its interface are **deleted**, not deprecated.
- `FileTapCommandOutbox`, `runOrQueueTapCommand`, `queued-commands.ts` are **deleted or reduced to trivial passthroughs** after the journal absorbs their role.
- `acked` status is **removed** from the enum, not left in place "for compatibility". The one site that sets it is updated.
- `retryPendingConnectionResults()` is **rewritten smaller** because the ordering fix removes most of what it currently reconciles.
- `--yes` / the pre-send approval prompt on `tap connect` is **deleted**, not flagged off.
- `CONNECT_RECEIPT_TIMEOUT_MS` as a separate public knob is **deleted**; the new single `waitMs` handles the full window.
- Tests for deleted structures are deleted. Tests for new structures are written alongside the new code.

If a component can be reduced rather than refactored, it is reduced.

## Design

### 1. Data model changes

#### 1.1 `Contact.status` gains `"connecting"`

```ts
type ConnectionStatus = "connecting" | "active" | "idle" | "stale" | "revoked"
```

A `connecting` contact:
- Is written by the connector immediately after it decides to send `connection/request`.
- Carries the invite's `expires` field as `Contact.expiresAt?: string` (ISO timestamp).
- Is shown by `contacts list` with a distinct badge and time-until-expiry.
- Is auto-deleted by opportunistic cleanup on any transport-owning command when `expiresAt` has passed. Cleanup also runs at the start of `TapMessagingService.start()`.

#### 1.2 `pending-connects.json` is deleted

`FilePendingConnectStore` and `IPendingConnectStore` are removed. All call sites shift to `trustStore.findByAgentId()` + `status === "connecting"`. The one-time migration (see §6) reads the file on first run of the new version, upserts `connecting` contacts, and deletes the file.

#### 1.3 `request-journal.json` schema

```ts
type RequestJournalStatus = "queued" | "pending" | "completed"
```

- `acked` is removed. The one site that sets it (`service.ts:1546`) is deleted.
- `queued` is added. It represents an outbound intent whose wire request has not yet been sent (transport owned by another process, or not yet open).
- `RequestJournalEntry.metadata` gains an optional `lastError: { message: string; at: string; attempts: number }` for durable debugging of stuck entries.

Entry transitions:
- **Outbound requests** (e.g. `connection/request`, `action/request`): `queued → pending → completed` when the transport is owned by another process; `pending → completed` when the calling process owns the transport and can send immediately (the `queued` state is skipped).
- **Outbound results** (e.g. `connection/result`, `action/result`): `pending → completed`. Always triggered by an incoming request that the calling process is handling in-process, so `queued` never applies.
- **Inbound** (requests and results): `pending → completed`. No `queued` because the wire has already been touched by the time the entry is written.
- On unrecoverable error: entry is **deleted**. Logs are the audit trail for failures. This is a deliberate simplicity call.

#### 1.4 `tap-commands-outbox.json` is deleted

Command intents become `queued` outbound journal entries. The wire `requestId` is generated at intent time via `generateNonce()`; the `requestKey` for outbound entries is `outbound:${requestId}`. Reuse on retry is guaranteed because the intent record carries the requestId.

### 2. Wire protocol changes

**None.** Every JSON-RPC method, payload field, and bootstrap rule stays identical. This is purely a local state refactor.

### 3. Public API changes

#### 3.1 `TapMessagingService.connect()` becomes truly synchronous

```ts
connect(params: {
  inviteUrl: string;
  waitMs?: number;  // default 30_000; 0 = fire-and-forget
}): Promise<{
  status: "active" | "pending";
  connectionId?: string;
  peerName: string;
  peerAgentId: number;
}>
```

Behavior:

1. Resolve inviter identity, verify invite signature, reject self-invites and expired invites.
2. Upsert a `connecting` contact with `expiresAt` from the invite.
3. **If transport is owned by this process:**
   - Build `connection/request` with a fresh `requestId`.
   - Register an in-memory waiter keyed on `requestId` in `inFlightWaiters: Map<string, Waiter>`.
   - Call `transport.send(...)`. On send failure: remove the waiter, leave the `connecting` contact in place (it expires naturally), propagate the error to the caller. On send success: write a `pending` outbound journal entry (skipping `queued`).
   - Await either the waiter resolving (via `onResult()`) or `waitMs` timeout.
   - On resolve: return `{ status: "active", ... }`. Contact row was flipped by `handleConnectionResult`.
   - On timeout: return `{ status: "pending", ... }`. Waiter is removed; a future `connection/result` still lands via the normal handler path and flips the contact on the next `syncOnce`.
4. **If transport is owned by another process:**
   - Write a `queued` outbound journal entry with the fresh `requestId` and the full `connection/request` payload serialized in `metadata`.
   - Poll the trust store for the contact becoming `active` within `waitMs`. The transport owner (e.g. listener or plugin) drains `queued` entries independently.
   - Return `active` or `pending` depending on outcome.
5. `waitMs === 0` skips the waiting step in both paths and returns immediately.

**No throw on timeout.** Callers distinguish `active` vs `pending` via the return value. Timeouts are an expected outcome, not exceptional.

#### 3.2 `inFlightWaiters` map

In-memory only. Lives on `TapMessagingService`. Entries: `{ resolve, reject, timer, requestId, peerAgentId }`. Cleared by:
- Matching `connection/result` arriving in `onResult()`.
- `waitMs` timeout firing.
- `service.stop()` rejecting all outstanding waiters.

No persistence. The durable state is the `connecting` contact + journal entry; the waiter just bridges a local promise to the async result.

#### 3.3 `approveConnection` hook unchanged

`null` still means "leave in `pending`, defer to operator." The new `tap permissions pending` CLI command filters inbound `pending` entries by method to surface them. No new state needed.

### 4. CLI behavior changes

#### 4.1 `tap connect <url>`

| Flag | Default | Behavior |
|---|---|---|
| *(none)* | 30s blocking wait | Returns when contact is `active` or `waitMs` expires. Exit 0 on `active`, exit 2 on timeout with a message pointing at `tap message sync`. |
| `--no-wait` | — | Returns immediately after intent is durable. Prints `pending`. Exit 0. Intended for scripts. |
| `--wait-seconds N` | — | Override the default. `N === 0` is equivalent to `--no-wait`. Kept for script compatibility. |
| `--yes` | — | **Removed.** No pre-send prompt. The only security-relevant approval is Alice's. |

Exit codes:
- 0: `active` (or `pending` when `--no-wait` was requested).
- 2: timed out waiting for `active`.
- Non-zero (existing): validation, network, or verification error.

#### 4.2 `tap journal list` / `tap journal show <id>` (new, small)

Read-only inspection over `request-journal.json`. Fields shown: state, direction, method, peer agent id, age, lastError. Helps debug stuck entries without reading JSON by hand. Justification: we are consolidating into one journal — users need a minimal CLI view into it.

#### 4.3 Other CLI commands

`tap message send`, `tap message sync`, `tap message listen`, `tap message request-funds`, `tap message request-meeting`, `tap permissions update`, `tap permissions revoke`:

- All of these currently call `runOrQueueTapCommand`. They continue to do so, but internally it now writes `queued` journal entries instead of outbox entries. Their external behavior is unchanged.
- `runOrQueueTapCommand` shrinks to a thin wrapper that (a) tries to acquire the transport lock, (b) on failure writes a `queued` journal entry and waits briefly for draining, (c) reports back the journal entry's terminal state. Its size is expected to drop substantially.

### 5. Inviter-side ordering fix (R2)

`processConnectionRequest` today performs:
1. Accept connection.
2. Write contact as `active` (`addContact` or `updateContact`).
3. Persist outbound result delivery to journal.
4. Send `connection/result`.
5. Mark inbound request `completed`.

Steps 2 and 4 are in the wrong order. A failure at step 4 leaves Alice with an active contact Bob does not know about, and `retryPendingConnectionResults()` exists to reconcile this.

New order:
1. Accept connection.
2. Persist outbound result delivery to journal with status `pending`.
3. Send `connection/result` and await XMTP receipt.
4. **Only if step 3 succeeds**, write contact as `active`.
5. Mark inbound request `completed`.

If step 3 fails: entry remains `pending` with `metadata.lastError` updated. Alice's contact stays unwritten. Reconciliation on next transport-owning run resends the result from the journal entry and, on success, writes the contact. `retryPendingConnectionResults()` is reduced to this single responsibility and most of its current logic is deleted.

Edge case: inbound request is a re-delivery and Alice already has the contact as `active` from a prior run. The handler still sends `connection/result` (idempotent for Bob) and skips the contact write. Journal entry proceeds to `completed`.

### 6. Migration

Runs once on `TapMessagingService.start()`:

1. **pending-connects → connecting contacts.** If `pending-connects.json` exists, read each `PendingConnectRecord`, upsert a `connecting` contact with fields mapped from the record. Delete the file.
2. **outbox → queued journal entries.** If `tap-commands-outbox.json` exists, read each entry, generate a fresh `requestId`, write a `queued` outbound journal entry with the intent payload in `metadata`. Delete the file.
3. **acked → pending.** Scan journal for entries with status `acked` and rewrite to `pending`.

All three steps are idempotent. If migration is interrupted, rerunning is safe.

No config version bump. No user-visible message. Logs note the migration at info level.

### 7. Test plan

**Unit (added/updated):**
- `packages/core/test/trust/contacts.test.ts`: `connecting` round-trip, `expiresAt` persistence, opportunistic expiry cleanup.
- `packages/core/test/runtime/request-journal.test.ts`: `queued → pending → completed`, `metadata.lastError` updates, migration of legacy `acked` entries.
- `packages/core/test/runtime/service.connect.test.ts`: sync waiter resolves on matching result, timeout returns `pending`, ordering fix (failed send leaves contact unwritten).
- `packages/core/test/runtime/service.waiters.test.ts`: waiter cleanup on resolve, timeout, and `stop()`.
- `packages/core/test/runtime/migration.test.ts`: all three migration steps idempotent.

**Integration (XMTP):**
- `packages/core/test/integration/xmtp.connect.test.ts`: two-agent connect happy path; connector timeout + reconcile via `syncOnce`; inviter send failure + retry via reconciliation.

**E2E (both `e2e-mock.test.ts` and `e2e-live.test.ts`, per `CLAUDE.md`):**
- Existing invite + connect scenario: assertions updated to expect `connecting` → `active` transition.
- New scenario: `--no-wait` returns immediately with `pending`; `tap message sync` finishes the flow.
- New scenario: connector runs `tap connect` while another process holds the transport → journal drains the `queued` entry when the transport frees.

**Deleted tests:**
- Any direct test of `FilePendingConnectStore`.
- Any direct test of `FileTapCommandOutbox` as a standalone concept.
- `acked` transition tests.
- Any `CONNECT_RECEIPT_TIMEOUT_MS`-specific timeout test that is subsumed by the new `waitMs` logic.

Test ordering during implementation (see §9 commit boundaries): each commit includes its own tests, and `bun run test && bun run typecheck && bun run lint` must pass before moving to the next commit.

### 8. Docs + skill updates

Mandatory:

- `skills/trusted-agents/SKILL.md`:
  - `tap connect` section rewritten: document the default 30s blocking behavior, `--no-wait`, `--wait-seconds`, exit codes. State that `--yes` is removed.
  - New "Debugging" subsection under `tap journal list` / `tap journal show`.
  - `tap permissions pending` section updated to describe how it surfaces deferred inbound connection/requests.
- `CLAUDE.md`:
  - "Non-Obvious Behavior" item 15: rewrite to reflect single-journal model. Delete `pending-connects.json` reference.
  - File layout tree: remove `pending-connects.json` and `tap-commands-outbox.json`.
  - "If You Change X, Also Check Y" → "Changing contact or conversation persistence": remove outbox and pending-connects references.
- `packages/openclaw-plugin/` internal notes: review for any mention of `pending-connects.json` or outbox; update if present.

The `prebuild` step that copies `skills/trusted-agents/` into `packages/openclaw-plugin/skills/` continues unchanged, so plugin copies pick up the canonical SKILL.md automatically.

### 9. Commit boundaries

Single PR, multiple commits, ordered so each commit passes all tests on its own:

1. **R1+R2 — Data model + ordering fix.**
   - Add `"connecting"` to `ConnectionStatus`.
   - Delete `FilePendingConnectStore`. Move all call sites to trust store.
   - Fix `processConnectionRequest` ordering. Shrink `retryPendingConnectionResults`.
   - Migration step 1.
   - Tests.
2. **R4 — Journal state machine cleanup.**
   - Remove `acked`. Delete the one site that sets it.
   - Add `metadata.lastError` type.
   - Migration step 3.
   - Tests.
3. **R3+R6 — Sync `connect()` + remove pre-prompt.**
   - Add `inFlightWaiters` to `TapMessagingService`.
   - Rewrite `connect()` to the new shape with `waitMs`.
   - Delete `CONNECT_RECEIPT_TIMEOUT_MS` public knob.
   - CLI: remove `--yes`, add `--no-wait`, update exit codes, update success/failure copy.
   - SKILL.md and CLAUDE.md updates for `tap connect`.
   - Tests.
4. **R5 — Fold outbox into journal.**
   - Add `"queued"` state.
   - Delete `FileTapCommandOutbox`. Reduce `runOrQueueTapCommand` to a thin wrapper.
   - Plugin drain loop scans for `queued` entries.
   - Migration step 2.
   - Add `tap journal list` / `tap journal show`.
   - Tests.
5. **Docs + skill final sweep.**
   - SKILL.md, CLAUDE.md, prebuild path verification.
   - E2E test updates for both mock and live.

If any commit hits a blocker during implementation, the prior commits are individually reviewable and could land as a partial PR.

## Open questions

None at design approval time. Resolution of any issues during implementation is handled in the plan phase.
