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
- `approveConnection` is a redundant hook: an invite is already cryptographic consent, so asking the inviter to approve at request time duplicates what the invite signature already proves. Today it is dead code in the CLI and a pure deferral no-op in the OpenClaw plugin.
- `connect()` silently no-ops on an already-`active` contact, which means if local state diverges (e.g. a peer has wiped their data but the other side still thinks they're connected), re-running `tap connect` cannot repair the divergence.
- Handlers on both sides carry rejection paths for "already known" contact states, meaning a valid retried request or result can be dropped depending on prior local state. Recovery requires manual `tap contacts remove` steps before reconnecting.

This spec eliminates the duplicate state, makes `tap connect` actually synchronous, fixes the ordering, collapses the state machine, and makes handlers fully idempotent so any reconnect attempt is self-healing.

## Goals

1. One source of truth per logical operation. No cross-file invariants to maintain.
2. `tap connect` either returns `active` or a clean error/`pending` within a bounded time. Never misleading.
3. Alice cannot end up in a state where she thinks Bob is a contact but Bob never got the result.
4. Minimum viable state machine. Every state must justify itself by recovery behavior.
5. **Any attempt to reconnect always fixes the problem.** Handlers are idempotent on every contact state; re-running `tap connect` with a fresh invite is the universal recovery procedure regardless of what local state either side is in.
6. Remove technical debt as part of the change — delete dead code paths, delete unused files, delete the old data structures. No compatibility shims, no rename churn.

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
- Is written by the connector immediately after it decides to send `connection/request`, before any wire traffic. This is Bob's durable "I asked" record; the send comes after.
- Carries the invite's `expires` field as `Contact.expiresAt?: string` (ISO timestamp) for display only.
- Is shown by `contacts list` with a distinct badge and a hint if the invite expiry has passed ("invite expired — peer will reject a retry; run `tap contacts remove` or request a fresh invite").
- **Is sticky.** Not auto-deleted. Lives until one of: (a) the flow completes to `active`, (b) the user runs `tap contacts remove`, (c) the user runs `tap contacts prune` explicitly. This preserves Bob's "I asked" record across arbitrary downtime, so the flow heals cleanly whenever he eventually syncs, regardless of how long it took.

The inviter-side invite expiry check (`validateInboundInvite` → `isExpired(invite.expires)`) still rejects stale invites on the wire. Connector-side stickiness only affects local bookkeeping, not protocol acceptance.

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

#### 1.5 `approveConnection` hook is removed

An invite is cryptographic consent: Alice signs `{agentId, chain, expires}` with her agent key. Any `connection/request` that verifies against her agent address is, by construction, one she authorized. Asking her to approve again at request time is redundant. Concretely:

- The `approveConnection` field is **deleted** from `NotificationAdapter` (or wherever it is declared) and from all call sites.
- `processConnectionRequest` always auto-accepts validly-signed, unexpired invites. No hook dispatch, no deferral branch, no `null`-result handling.
- The OpenClaw plugin's `approveConnection: async () => null` stub is **deleted** from `packages/openclaw-plugin/src/registry.ts`.
- The `CONNECTION_REQUEST` branch of `resolvePending` is **deleted**. The function now handles only `ACTION_REQUEST` entries (transfers, scheduling), which still require grant-gated approval.
- The escalation path that fires on inbound `connection/request` (`requestHeartbeatNow`, `enqueueSystemEvent`) is **replaced** by a post-success `connection-established` info-level notification, emitted after the contact is written as `active`.

Net delete: ~80 lines across `service.ts`, `packages/openclaw-plugin/src/registry.ts`, and the notification pipeline. If a future "review every incoming connection" mode is needed for paranoid environments, it comes back as a config flag — not as dead code waiting for a feature.

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
2. Upsert a `connecting` contact with `expiresAt` from the invite. This is the durable "I asked" record and is written **before** any wire traffic. If the upsert finds the peer already in any status — including `active` — the row is still written/touched and the flow proceeds (see §3.1.1 on idempotency).
3. Check for an existing non-terminal outbound journal entry targeting this peer. If one exists, reuse its `requestId` instead of minting a new one. This makes `tap connect` wire-level idempotent across retries — re-running the command produces at most one wire exchange per distinct in-flight request.
4. **If transport is owned by this process:**
   - Build `connection/request` with the reused or fresh `requestId`.
   - Register an in-memory waiter keyed on `requestId` in `inFlightWaiters: Map<string, Waiter>`.
   - Call `transport.send(...)`. On send failure: remove the waiter, leave the `connecting` contact in place (so the next retry reuses it), propagate the error to the caller. On send success: write/update the outbound journal entry as `pending` (skipping `queued`).
   - Await either the waiter resolving (via `onResult()`) or `waitMs` timeout.
   - On resolve: return `{ status: "active", ... }`. Contact row was flipped by `handleConnectionResult`.
   - On timeout: return `{ status: "pending", ... }`. Waiter is removed; a future `connection/result` still lands via the normal handler path and flips the contact on the next `syncOnce`.
5. **If transport is owned by another process:**
   - Write a `queued` outbound journal entry with the reused or fresh `requestId` and the full `connection/request` payload serialized in `metadata`.
   - Poll the trust store for the contact becoming `active` within `waitMs`. The transport owner (e.g. listener or plugin) drains `queued` entries independently.
   - Return `active` or `pending` depending on outcome.
6. `waitMs === 0` skips the waiting step in both paths and returns immediately.

**No throw on timeout.** Callers distinguish `active` vs `pending` via the return value. Timeouts are an expected outcome, not exceptional.

#### 3.1.1 `connect()` is self-healing on already-connected peers

The existing `service.ts:882-889` early-return on `existing?.status === "active"` is **removed**. `connect()` is an explicit user intent to verify the connection end-to-end, and silent divergence between peers is a real failure mode we need to recover from (see §10). Under the new behavior:

- If the caller's local contact is already `active`, `connect()` still sends a `connection/request` and awaits a result.
- The peer's `handleConnectionRequest` is idempotent (see §5.2) and sends a fresh `connection/result` regardless of its own existing contact state.
- The caller's `handleConnectionResult` is idempotent (see §5.3) — if it already has the contact as `active`, the result is a no-op; if it's missing (e.g. wiped locally), the result creates a fresh `active` contact.

The only cost is one extra XMTP round-trip on an already-healthy connection, bounded to explicit user action. The benefit is that running `tap connect` with a fresh invite always repairs confused state, which is the mental model users reach for naturally.

#### 3.2 `inFlightWaiters` map

In-memory only. Lives on `TapMessagingService`. Entries: `{ resolve, reject, timer, requestId, peerAgentId }`. Cleared by:
- Matching `connection/result` arriving in `onResult()`.
- `waitMs` timeout firing.
- `service.stop()` rejecting all outstanding waiters.

No persistence. The durable state is the `connecting` contact + journal entry; the waiter just bridges a local promise to the async result.

#### 3.3 Sync ordering invariant

Incoming messages within a single XMTP conversation **must be processed in delivery order**. XMTP already guarantees per-conversation total ordering; this invariant says we must not break it by introducing concurrent processing inside `TapMessagingService`.

Why it matters: Alice is free to mark Bob `active` and immediately send follow-up messages (e.g. `message/send`) while Bob is offline. They all queue in the Alice↔Bob XMTP conversation in order. When Bob next syncs, the `connection/result` must be processed before the follow-up messages, or the follow-ups will hit the transport-layer unknown-sender rejection.

Concrete invariant: `syncOnce()` and the listener loop iterate XMTP messages serially per conversation and `await` each handler before moving to the next. Any future refactor introducing worker pools or concurrent processing must preserve per-conversation order. A test in `service.sync-ordering.test.ts` exercises this with interleaved `connection/result` + `message/send`.

#### 3.4 `tap contacts remove` sends `connection/revoke`

Today, `tap contacts remove` is a local-only delete. The counterpart has no idea and keeps the removed party in its trust store. This is a latent divergence source and a minor bug independent of this spec, but we fix it here because it completes the recovery toolkit.

New behavior:
1. The command enqueues a `connection/revoke` message targeting the peer via the standard journal path (`queued` if transport is busy, `pending` if send goes out immediately).
2. The local contact is deleted from `contacts.json` immediately, regardless of whether the revoke has been delivered.
3. The `connection/revoke` entry drains asynchronously. If the peer is online, they process it and remove their contact. If offline, the entry sits as `queued`/`pending` until next transport-owning run.

Handler on the peer side (`processConnectionRevoke`, already exists) is idempotent: deletes the contact if present, no-ops if missing.

This gives users a correct "I want out" primitive that converges both sides.

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

### 5. Handler idempotency and ordering

#### 5.1 Inviter-side ordering fix (R2)

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
4. **Only if step 3 succeeds**, write/update contact per the idempotency table in §5.2.
5. Mark inbound request `completed`.

If step 3 fails: entry remains `pending` with `metadata.lastError` updated. Alice's contact stays unwritten. Reconciliation on next transport-owning run resends the result from the journal entry and, on success, writes the contact. `retryPendingConnectionResults()` is reduced to this single responsibility and most of its current logic is deleted.

#### 5.2 `handleConnectionRequest` idempotency table

Alice's handler must converge on `status === "active"` regardless of prior state. Every branch below ends with a `connection/result` sent (assuming the invite is valid) — there are no rejection paths for known peers.

| Existing contact state | Action |
|---|---|
| *missing* | Create a fresh `active` contact. Send result. |
| `connecting` (edge case — Alice is normally the inviter, but handle it defensively) | Upgrade to `active`. Send result. |
| `active` | Touch `updatedAt`. Send result (idempotent for the counterpart). |
| `idle` / `stale` | Upgrade to `active`. Send result. |
| `revoked` | Create a fresh `active` contact, overwriting the revoked record. Send result. Rationale: revokes are one-shot cleanup, not permanent blocks. A valid signed invite counts as renewed consent. |

The one remaining rejection path is the invite itself failing validation (`validateInboundInvite`): bad signature, expired, or targeted at the wrong local agent. In that case, the handler sends `connection/result` with `status: "rejected"` and does not touch the trust store.

#### 5.3 `handleConnectionResult` idempotency table

Bob's handler must converge on `status === "active"` whenever the result carries a valid identity, regardless of local prior state.

| Local contact state | Action |
|---|---|
| `connecting` | Flip to `active`. Normal happy path. |
| `active` | No-op on the contact; handler returns "already active" so caller can mark any matching journal entry `completed`. Retry-safe. |
| *missing* (Bob wiped local state) | **Create a fresh `active` contact** using the sender's identity resolved on-chain. Safe because the XMTP transport layer's bootstrap sender verification has already confirmed the sender's agent address matches the claimed `from.agentId` — no spoofing is possible without compromising the peer's XMTP identity, at which point the whole identity model is already broken. A comment in the handler points at this reasoning. No journal entry exists in this case (Bob wiped), so nothing to mark. |
| `revoked` | Log and ignore. Bob explicitly revoked; an incoming stale result should not resurrect the contact. If a matching journal entry exists, mark `completed` to stop retries. |
| `idle` / `stale` | Flip to `active`. Treat identically to `connecting`. |

Journal correlation is **best-effort**: after the contact transition, look up the outbound journal entry by `correlationId === result.requestId` and mark it `completed` if present. A missing journal entry is not an error in any of the cases above — the contact state is the source of truth for "are we connected."

This is the rule that delivers "any attempt to connect again always fixes the problem." Bob can wipe his disk, get a fresh invite from Alice, and either his own `connect` call or an arriving retried result from Alice will rebuild his local contact transparently.

### 6. Migration

Runs once on `TapMessagingService.start()`:

1. **pending-connects → connecting contacts.** If `pending-connects.json` exists, read each `PendingConnectRecord`, upsert a `connecting` contact with fields mapped from the record. Delete the file.
2. **outbox → queued journal entries.** If `tap-commands-outbox.json` exists, read each entry, generate a fresh `requestId`, write a `queued` outbound journal entry with the intent payload in `metadata`. Delete the file.
3. **acked → pending.** Scan journal for entries with status `acked` and rewrite to `pending`.

All three steps are idempotent. If migration is interrupted, rerunning is safe.

No config version bump. No user-visible message. Logs note the migration at info level.

### 7. Test plan

**Unit (added/updated):**
- `packages/core/test/trust/contacts.test.ts`: `connecting` round-trip, `expiresAt` persistence, stickiness (no auto-deletion).
- `packages/core/test/runtime/request-journal.test.ts`: `queued → pending → completed`, `metadata.lastError` updates, migration of legacy `acked` entries.
- `packages/core/test/runtime/service.connect.test.ts`: sync waiter resolves on matching result, timeout returns `pending`, ordering fix (failed send leaves contact unwritten), wire-level idempotency (re-running `connect` reuses an existing non-terminal journal entry).
- `packages/core/test/runtime/service.waiters.test.ts`: waiter cleanup on resolve, timeout, and `stop()`.
- `packages/core/test/runtime/migration.test.ts`: all three migration steps idempotent.
- `packages/core/test/runtime/service.handler-idempotency.test.ts`: drives `handleConnectionRequest` and `handleConnectionResult` through every row of the §5.2 / §5.3 tables.
- `packages/core/test/runtime/service.sync-ordering.test.ts`: interleaved `connection/result` + `message/send` arriving in the same sync pass processes the result first; sent-after-active messages are accepted.
- `packages/core/test/runtime/service.auto-accept.test.ts`: inbound `connection/request` is auto-accepted without the deleted `approveConnection` hook.

**Recovery tests (new file `packages/core/test/runtime/service.recovery.test.ts`):**
- **Bob wipes, Alice reconnects:** Bob starts with an `active` contact for Alice, wipes all local state, receives a fresh invite, runs `connect` → converges to `active` on both sides.
- **Alice wipes, Bob reconnects:** Alice starts with an `active` contact for Bob, wipes, issues a new invite (simulated out-of-band), Bob runs `connect` → converges to `active` on both sides. Verifies the early-return removal works.
- **Re-connect on already-active contact:** starting from a healthy `active` state on both sides, Bob runs `connect` again → produces exactly one wire request and one wire result, stays `active` on both sides.
- **`handleConnectionResult` with missing local contact:** directly invokes the handler with a valid result and no local `connecting`/`active` row → creates a fresh `active` contact. Mocks the transport-level sender verification.
- **`tap contacts remove` sends revoke:** Bob removes Alice; verifies a `connection/revoke` journal entry is enqueued and the local contact is deleted immediately. A subsequent `syncOnce` on Alice's side processes the revoke and removes her contact for Bob.

**Integration (XMTP):**
- `packages/core/test/integration/xmtp.connect.test.ts`: two-agent connect happy path; connector timeout + reconcile via `syncOnce`; inviter send failure + retry via reconciliation.
- `packages/core/test/integration/xmtp.recovery.test.ts`: two-agent wipe-and-recover scenarios running against a real XMTP transport.

**E2E (both `e2e-mock.test.ts` and `e2e-live.test.ts`, per `CLAUDE.md`):**
- Existing invite + connect scenario: assertions updated to expect `connecting` → `active` transition.
- New scenario: `--no-wait` returns immediately with `pending`; `tap message sync` finishes the flow.
- New scenario: connector runs `tap connect` while another process holds the transport → journal drains the `queued` entry when the transport frees.
- New scenario: reconnect-after-wipe end-to-end — delete one side's `contacts.json` + `request-journal.json`, issue a new invite, run `tap connect`, assert both sides converge.

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
  - New "Recovery" subsection documenting the single mental model: "if anything feels stuck, exchange a fresh invite and run `tap connect`." Lists the three-command recovery toolkit (`tap connect`, `tap message sync`, `tap contacts remove`).
  - `tap permissions pending` section updated to state it only surfaces deferred action requests (transfers, scheduling), not connection requests — since `approveConnection` is removed and connections are always auto-accepted on valid invites.
  - `tap contacts remove` section updated to state it sends `connection/revoke` to the peer before deleting locally.
  - OpenClaw-specific section updated to remove any mention of connection-request approval deferral. Replace with the post-success `connection-established` notification behavior.
- `CLAUDE.md`:
  - "Non-Obvious Behavior" item 15: rewrite to reflect single-journal model. Delete `pending-connects.json` reference.
  - "Non-Obvious Behavior" item 16 (OpenClaw plugin): remove the "connection requests always defer for user approval via the `approveConnection` hook" sentence. Replace with "connection requests are auto-accepted on valid invites; a post-success notification is emitted via `emitEvent`."
  - File layout tree: remove `pending-connects.json` and `tap-commands-outbox.json`.
  - "If You Change X, Also Check Y" → "Changing contact or conversation persistence": remove outbox and pending-connects references.
  - "Core Abstractions To Preserve" → `NotificationAdapter + ApprovalHandler`: remove any mention of `approveConnection`. Keep `approveTransfer`.
- `packages/openclaw-plugin/` internal notes: review for any mention of `pending-connects.json`, outbox, or `approveConnection`; update or delete if present.

The `prebuild` step that copies `skills/trusted-agents/` into `packages/openclaw-plugin/skills/` continues unchanged, so plugin copies pick up the canonical SKILL.md automatically.

### 9. Commit boundaries

Single PR, multiple commits, ordered so each commit passes all tests on its own:

1. **R1+R2 — Data model + ordering fix + handler idempotency.**
   - Add `"connecting"` to `ConnectionStatus`. No auto-expiry (sticky).
   - Delete `FilePendingConnectStore`. Move all call sites to trust store.
   - Fix `processConnectionRequest` ordering. Shrink `retryPendingConnectionResults`.
   - Implement the §5.2 and §5.3 idempotency tables in `handleConnectionRequest` and `handleConnectionResult`. Remove the `connectInternal` early-return on `active`.
   - Migration step 1.
   - Tests: contacts, ordering, idempotency tables, sync-ordering invariant.
2. **R4 — Journal state machine cleanup.**
   - Remove `acked`. Delete the one site that sets it.
   - Add `metadata.lastError` type.
   - Migration step 3.
   - Tests: journal transitions, `lastError` updates.
3. **R1.5 — Remove `approveConnection` hook + revoke-on-remove.**
   - Delete `approveConnection` from `NotificationAdapter` and all call sites.
   - Delete the OpenClaw plugin stub and the `CONNECTION_REQUEST` branch of `resolvePending`.
   - Replace the inbound escalation notification with a post-success `connection-established` info event.
   - Update `tap contacts remove` to enqueue a `connection/revoke` before deleting locally.
   - Tests: auto-accept, revoke-on-remove, handler idempotency for revoked peers.
4. **R3+R6 — Sync `connect()` + remove pre-prompt.**
   - Add `inFlightWaiters` to `TapMessagingService`.
   - Rewrite `connect()` to the new shape with `waitMs` and wire-level idempotency (reuse existing non-terminal journal entries).
   - Delete `CONNECT_RECEIPT_TIMEOUT_MS` public knob.
   - CLI: remove `--yes`, add `--no-wait`, update exit codes, update success/failure copy.
   - SKILL.md and CLAUDE.md updates for `tap connect`.
   - Tests: waiter lifecycle, timeout behavior, wire idempotency, recovery scenarios.
5. **R5 — Fold outbox into journal.**
   - Add `"queued"` state.
   - Delete `FileTapCommandOutbox`. Reduce `runOrQueueTapCommand` to a thin wrapper.
   - Plugin drain loop scans for `queued` entries.
   - Migration step 2.
   - Add `tap journal list` / `tap journal show`.
   - Tests: queued drain, migration idempotency.
6. **Docs + skill final sweep.**
   - SKILL.md, CLAUDE.md, prebuild path verification.
   - E2E test updates for both mock and live (including the wipe-and-recover scenario).

If any commit hits a blocker during implementation, the prior commits are individually reviewable and could land as a partial PR.

### 10. Recovery story

After this change, the recovery mental model is:

> **If anything feels stuck, exchange a fresh invite and run `tap connect`.**

That one command covers every realistic failure:

| Situation | Procedure | Result |
|---|---|---|
| Happy path, first connection | `tap connect <invite>` | `active` in ~seconds |
| Bob wipes local state, Alice is fine | Alice issues new invite → Bob runs `tap connect` | Bob's side has no prior state; fresh `connecting` → `active`. Alice's handler touches existing `active` contact and re-sends result. Both converge. |
| Alice wipes local state, Bob is fine | Alice issues new invite out-of-band → Bob runs `tap connect` | Previously broken: Bob's `connectInternal` early-returned on existing `active`. After §3.1.1 fix, Bob sends a fresh request; Alice creates a fresh `active` for him. Both converge. |
| Both sides wiped | Alice issues new invite → Bob runs `tap connect` | Trivially works (identical to a first-time connection). |
| Silent divergence of unknown cause | Alice issues new invite → Bob runs `tap connect` | Handlers are idempotent per §5.2 / §5.3, always converging to `active`. |
| Alice sent messages while Bob was offline | Bob runs `tap message sync` | XMTP delivers in order; `connection/result` processes first, subsequent `message/send`s land in the now-active contact. |
| Bob wants out | `tap contacts remove alice` | Local contact deleted immediately. `connection/revoke` drains asynchronously; Alice's side removes her contact when the revoke arrives. |
| Debugging stuck state | `tap journal list` / `tap journal show <id>` | Read-only view of in-flight and recent work with `lastError` surfaced. |

The three-command recovery toolkit is `tap connect`, `tap message sync`, `tap contacts remove`. Every failure mode maps to one of these three, and none of them require the user to understand the protocol internals.

**The only unrecoverable scenario:** both sides have data loss simultaneously *and* no out-of-band channel to deliver a fresh invite. This is inherent to local-first and is not addressed by this spec. It is called out explicitly in `SKILL.md` so users know to keep backups of at least their `config.yaml` (the OWS wallet binding is the only piece that matters — everything else can be rebuilt from peers).

## Open questions

None at design approval time. Resolution of any issues during implementation is handled in the plan phase.
