# Async Messaging Implementation Plan

Date: 2026-03-06

## Goal

Combine the best parts of the two research docs while keeping TAP simple:

- keep XMTP as the default cross-agent transport
- support OpenClaw as the main user-facing host environment without assuming we can modify OpenClaw itself
- make TAP protocol flows asynchronous first
- avoid building a separate TAP daemon/control plane
- update skills only when each phase lands so docs do not drift from code

## Decision Summary

1. Keep XMTP, but redesign `TransportProvider`.
2. Do not replace streaming with heartbeat polling.
3. Use the immediate JSON-RPC response as a transport receipt only.
4. Move business outcomes into explicit later result messages.
5. Replace the current method set with a smaller clean-slate protocol:
   - `connection/request`
   - `connection/result`
   - `connection/revoke`
   - `permissions/update`
   - `message/send`
   - `action/request`
   - `action/result`
6. Add a minimal durable TAP request journal for idempotency.
7. Use `syncAll` on startup and on periodic reconciliation.
8. For OpenClaw deployments, integrate through installed CLI + skills + heartbeat configuration, not by assuming TAP code runs inside the OpenClaw Gateway process.

## Why This Is The Simplest Path

- It does not require replacing XMTP.
- It does not require a new network service or local control plane.
- It gives TAP a transport abstraction that matches async semantics instead of fighting them.
- It generalizes a pattern already present in `message-request-funds`: immediate receipt plus later async response.
- It works whether the user runs TAP directly or drives it from OpenClaw.

## Phase 0: Guardrails And One-Time Decisions

### Decisions to lock before coding

1. The JSON-RPC response returned by `send()` becomes a receipt, not the business result.
2. A receipt means only:
   - the message was received by the remote TAP runtime
   - the message was syntactically valid enough to queue or reject
3. A receipt does not mean:
   - the business request was approved
   - the connection is active
   - the action completed
4. For OpenClaw deployments, the primary automation path is heartbeat-driven `tap message sync`.
5. `tap message listen` remains an optional real-time mode, not the baseline deployment requirement.

### Validation spike

Before implementation, confirm one XMTP SDK detail:

- whether the Node SDK exposes enough sync metadata to distinguish newly synced network messages from already persisted local state

Even if it does, still keep TAP-level durable idempotency. XMTP's SQLite DB is necessary for sync/install continuity, but it is not TAP business state.

## Phase 1: Redesign Transport And Make The Protocol Async

This is the prerequisite for everything else.

### Transport design

If backward compatibility does not matter, the current transport interface should change.

The current shape:

- `send(...) -> Promise<ProtocolResponse>`
- `onMessage(...) -> Promise<ProtocolResponse>`

hard-codes synchronous RPC semantics into the abstraction. That is the wrong boundary for TAP.

Replace it with something closer to:

```ts
interface TransportProvider {
  start(handlers: TransportHandlers): Promise<void>;
  stop(): Promise<void>;
  send(
    peerId: number,
    message: ProtocolMessage,
    options?: TransportSendOptions,
  ): Promise<TransportReceipt>;
  reconcile?(options?: TransportReconcileOptions): Promise<TransportReconcileResult>;
  isReachable(peerId: number): Promise<boolean>;
}

interface TransportHandlers {
  onRequest(envelope: InboundRequestEnvelope): Promise<TransportAck>;
  onResult(envelope: InboundResultEnvelope): Promise<void>;
}
```

Key change:

- transport handlers no longer return business results
- they only acknowledge receipt/queueing
- later business outcomes arrive as separate inbound result messages

### Receipt and ack contract

Add a small shared result type in core, for example:

```ts
interface TransportReceipt {
  received: true;
  requestId: string;
  status: "received" | "duplicate" | "queued";
  receivedAt: string;
}

interface TransportAck {
  status: "received" | "duplicate" | "queued";
}
```

Use JSON-RPC errors only for:

- invalid payload
- unauthorized sender
- inactive or unknown contact
- unrecoverable local failure before queuing

Transport should synthesize the JSON-RPC response for the sender automatically from `TransportAck`.

### Clean-slate canonical protocol methods

If backward compatibility does not matter, this is the better method set:

- `connection/request`
- `connection/result`
- `connection/revoke`
- `permissions/update`
- `message/send`
- `action/request`
- `action/result`

This is better than the current method set because:

- it cleanly separates one-way events from request/result workflows
- it avoids method explosion like `accept` + `reject` variants
- it removes the awkward coupling of actions under the `message/*` namespace
- it keeps permissions publication as a first-class protocol event instead of a connection-side detail
- it gives every async workflow one obvious correlation path: `request` followed by `result`

### Method behavior after this phase

- `connection/request`: returns transport receipt; later yields `connection/result`
- `permissions/update`: returns transport receipt only
- `message/send`: returns transport receipt only
- `action/request`: returns transport receipt; later yields `action/result`
- `connection/revoke`: returns transport receipt only

### Result payload shape

Make all async result methods share a consistent structure.

For `connection/result`:

```ts
interface ConnectionResultParams {
  requestId: string;
  requestNonce: string;
  from: AgentIdentifier;
  to: AgentIdentifier;
  status: "accepted" | "rejected";
  connectionId?: string;
  reason?: string;
  timestamp: string;
}
```

For `action/result`:

```ts
interface ActionResultParams {
  requestId: string;
  actionId: string;
  actionType: string;
  status: "completed" | "rejected" | "failed";
  result?: Record<string, unknown>;
  error?: string;
  timestamp: string;
}
```

This is better than separate `accept` and `reject` methods because:

- senders have one result subscription path
- duplicate/replay handling is simpler
- result parsing is more uniform
- future statuses like `expired` or `cancelled` fit naturally

### Files to change

- `packages/core/src/protocol/types.ts`
- `packages/core/src/protocol/messages.ts`
- `packages/core/src/transport/interface.ts`
- `packages/core/src/transport/xmtp.ts`
- `packages/core/src/protocol/methods.ts`
- `packages/cli/src/commands/message-send.ts`
- `packages/cli/src/commands/message-listen.ts`
- `packages/cli/src/commands/message-request-funds.ts`
- `packages/cli/src/lib/permission-workflows.ts`

### Acceptance criteria

- `send()` callers no longer treat the immediate response as approval/completion.
- Existing transfer action flow is refactored to match the new general model rather than being a special case.

## Phase 2: Make Connections Async

This is the highest-impact UX improvement.

### Design

Change `tap connect` from synchronous handshake to queued outbound request:

1. Connector resolves peer and verifies invite as today.
2. Connector sends `connection/request`.
3. Connector waits only for receipt.
4. Connector persists a pending local contact.
5. Receiver processes the request now or later.
6. Receiver sends `connection/result`.
7. Initiator updates local state when that later message arrives.

### Important simplification

Do not add a new pending-connections file unless necessary.

Reuse `contacts.json` with small optional pending metadata, for example:

```ts
pending?: {
  direction: "inbound" | "outbound";
  requestNonce: string;
  requestId: string;
  requestedAt: string;
  inviteNonce?: string;
}
```

This keeps the codebase simpler than adding a whole second store.

### Canonical methods

- outbound request: `connection/request`
- final decision: `connection/result`

### Fix invite redemption

When the inviter accepts an inbound `connection/request`, redeem the stored invite nonce atomically through `FilePendingInviteStore`.

This closes the current gap where invite creation is persisted but invite redemption is not part of the actual accept path.

### Files to change

- `packages/core/src/protocol/types.ts`
- `packages/core/src/connection/request-handler.ts`
- `packages/core/src/connection/pending-invites.ts`
- `packages/core/src/trust/types.ts`
- `packages/core/src/trust/file-trust-store.ts`
- `packages/core/src/transport/xmtp.ts`
- `packages/cli/src/commands/connect.ts`
- `packages/cli/src/commands/message-listen.ts`
- `packages/sdk/src/commands/connect.ts`
- `packages/sdk/src/orchestrator.ts`

### CLI behavior after this phase

`tap connect` should return something like:

- `status: "pending"` when the request is queued
- `status: "active"` only when an already-delivered `connection/result` with `accepted` status is processed before the command exits

Do not require the inviter to be listening at the moment `tap connect` runs.

## Phase 3: Add Durable Idempotency

XMTP persistence is necessary but not sufficient.

### Rule

Use XMTP SQLite for:

- local message/conversation persistence
- installation continuity
- sync watermarks/history

Use TAP request journaling for:

- duplicate suppression
- replay protection across restarts
- outbound pending-state recovery
- business-level exactly-once-ish semantics

### Minimal implementation

Add a small core store such as:

- `packages/core/src/runtime/request-journal.ts`

Backed by one JSON file under the data dir, for example:

- `<dataDir>/request-journal.json`

Track only what TAP needs:

- `requestKey`
- `direction`
- `method`
- `peerAgentId`
- `receivedAt`
- `ackedAt`
- `completedAt`
- `status`
- optional correlation key such as `actionId` or `requestNonce`

Suggested stable dedupe key:

- inbound: `senderInboxId + method + jsonrpc.id`
- for business correlation: also store `actionId` or `requestNonce` where available

### Why not rely on memory or conversation logs

- current dedupe in `XmtpTransport` is process-local only
- conversation logs do not cover every TAP method
- logs are not the right source of truth for replay control

### Files to change

- `packages/core/src/transport/xmtp.ts`
- `packages/core/src/transport/interface.ts`
- `packages/core/src/runtime/request-journal.ts` (new)
- `packages/core/src/runtime/index.ts` (new or updated export)
- `packages/cli/src/lib/context.ts`
- `packages/sdk/src/orchestrator.ts`

### Acceptance criteria

- duplicate inbound messages after restart are ignored safely
- repeated `syncAll` runs do not re-execute business logic
- pending outbound async requests can be resumed from disk

## Phase 4: Add `syncAll` Reconciliation

### Startup reconciliation

Run `syncAll(['allowed'])` before entering the long-lived stream loop.

Purpose:

- catch messages that arrived while offline
- catch `connection/result` and `action/result` follow-ups
- rebuild local pending state after restart

### Periodic reconciliation

Use a slow periodic safety sync:

- every 5 to 15 minutes in a long-running host

This is a safety net, not the primary receive path.

### Should this use OpenClaw Heartbeat?

Yes, for OpenClaw deployments.

But the integration needs to be framed correctly:

- we do not control OpenClaw
- we are not embedding TAP code into the Gateway
- users install our CLI and our skills into their OpenClaw environment

So heartbeat usage is:

- OpenClaw runs a scheduled agent turn
- our installed skill instructions tell the agent when to run `tap message sync`
- `HEARTBEAT.md` gives the recurring checklist
- the user enables/configures heartbeat in OpenClaw config

Recommended split:

- TAP CLI command `tap message sync` performs reconciliation
- OpenClaw heartbeat invokes that command periodically
- optional real-time responsiveness still comes from an externally supervised `tap message listen`

Why:

- heartbeat is a good scheduler for recurring reconcile work
- heartbeat is not a durable background process manager
- OpenClaw background `exec`/`process` sessions are memory-backed and lost on Gateway restart, so they are not a solid 24/7 listener deployment story

### Add a one-shot CLI for ops and cron

Add:

- `tap message sync [--yes] [--yes-actions]`

This should:

1. start transport
2. run `syncAll(['allowed'])`
3. process newly synced inbound messages through the same handler path
4. stop transport

This command is useful for:

- debugging
- recovery
- low-duty-cycle deployments
- OpenClaw heartbeat integration

It is the baseline OpenClaw integration mode.

It is not the only mode. Users who want near-real-time responsiveness can still run `tap message listen` under PM2/systemd/launchd outside OpenClaw.

### Files to change

- `packages/core/src/transport/xmtp.ts`
- `packages/cli/src/commands/message-listen.ts`
- `packages/cli/src/commands/message-sync.ts` (new)
- `packages/cli/src/cli.ts`
- `packages/sdk/src/orchestrator.ts`

## Phase 5: OpenClaw Integration Without Owning OpenClaw

### Reality constraint

We are shipping:

- the `tap` CLI
- TAP skills
- TAP documentation

We are not shipping:

- code inside OpenClaw core
- a Gateway plugin with privileged runtime hooks
- a TAP-owned long-lived service inside OpenClaw

So the OpenClaw integration story must work with installed tools and skills only.

### What not to rely on

- detached terminal tabs
- `screen`/`tmux` as the main production story
- OpenClaw background `exec`/`process` sessions for a permanent listener

Why not OpenClaw background `exec`/`process`:

- background sessions are kept in memory
- they are lost on Gateway restart
- they are not a disk-persistent supervisor

Those are acceptable developer stopgaps, not deployment strategy.

### Recommended OpenClaw integration model

Support two documented modes:

1. Baseline async mode:
   - user installs `tap`
   - user installs TAP skills into OpenClaw
   - user enables heartbeat in OpenClaw config with `target: "none"` and `lightContext: true`
   - user adds a small `HEARTBEAT.md`
   - heartbeat periodically runs `tap message sync`

2. Optional real-time mode:
   - all of the above
   - user also runs `tap message listen` under OS supervision outside OpenClaw

This keeps the codebase simple and matches what we actually control.

### What to ship in this repo

- `tap message sync`
- updated TAP skills
- an OpenClaw setup reference file, for example:
  - `packages/sdk/skills/trusted-agents/references/openclaw-heartbeat.md`
- README/runbook snippets showing:
  - OpenClaw heartbeat config
  - example `HEARTBEAT.md`
  - optional PM2/systemd/launchd listener setup

### Recommended OpenClaw config snippet to document

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "every": "15m",
        "target": "none",
        "lightContext": true,
        "prompt": "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. If TAP reconciliation is needed, run it. If nothing needs attention, reply HEARTBEAT_OK."
      }
    }
  }
}
```

### Recommended `HEARTBEAT.md` snippet to document

```md
# TAP heartbeat checklist

- Run `tap message sync --yes --yes-actions` for this agent's TAP data dir.
- Process any pending `connection/result` or `action/result` updates.
- If a connection or action needs human attention, report it clearly.
- If nothing needs attention, reply `HEARTBEAT_OK`.
```

### Non-OpenClaw fallback

- continue to support `tap message listen`
- document PM2/system service usage
- keep `tap message sync` available as a maintenance command

## Phase 6: Update Skills In Lockstep

Do not update shipped skill docs until the related code lands.

### Files to update

- `packages/sdk/skills/trusted-agents/SKILL.md`
- `packages/sdk/skills/trusted-agents/connections/SKILL.md`
- `packages/sdk/skills/trusted-agents/messaging/SKILL.md`
- `packages/sdk/skills/trusted-agents/references/openclaw-heartbeat.md` (new)

### Root skill changes

Replace:

- "Start `tap message listen` before expecting inbound..."

With:

- "If running inside OpenClaw, configure heartbeat and `HEARTBEAT.md` so the agent runs `tap message sync` periodically."
- "Use `tap message listen` for foreground debugging."
- "Use `tap message sync` for reconciliation and heartbeat-driven maintenance."

### Connections skill changes

Replace:

- "The inviter should be running `tap message listen`."

With:

- "`tap connect` queues an async request. The peer can respond later with `connection/result`."
- explain pending vs active outcomes

### Messaging skill changes

Add:

- `tap message sync`
- explanation that transport receipts are not business approvals
- OpenClaw heartbeat guidance
- note that skills can guide heartbeat usage but do not schedule it themselves

### Skill eval prompts to add

Per skill-creator guidance, add lightweight eval prompts when the skills change:

1. "I want my OpenClaw agent to stay reachable for TAP messages without running a manual terminal listener."
2. "How do I connect to a friend's agent if they're offline right now?"
3. "What's the difference between `tap message listen` and `tap message sync`?"

## Testing Plan

### Core tests

- update transport unit tests for receipt semantics
- add duplicate/replay tests across restart boundaries
- add tests for `syncAll` reconciliation behavior

### CLI tests

- update `packages/cli/test/e2e-two-agent-flow.test.ts`
- add offline connect scenario:
  - inviter offline
  - connector runs `tap connect`
  - inviter later syncs/listens
  - inviter accepts
  - connector later syncs/listens and becomes active
- add `tap message sync` tests

### SDK/OpenClaw-facing tests

- repeated `tap message sync` runs are idempotent
- heartbeat-driven sync does not re-execute old requests
- OpenClaw-oriented docs/examples use valid config structure

## Rollout Order

1. Async receipt semantics
2. Async connections using `connection/result`
3. Request journal and durable idempotency
4. `syncAll` on startup plus `tap message sync`
5. OpenClaw integration docs + skill updates
6. README and live smoke runbook updates

## Non-Goals For This Iteration

- no new TAP daemon
- no local control socket/API
- no queue bridge
- no new transport implementation
- no websocket-specific work
- no serverless-first deployment model

## Final Recommendation

Build this as an async TAP CLI with a clean transport boundary, then make OpenClaw drive it through heartbeat and skills.

That gives you:

- offline-resolvable connections
- simpler TAP semantics
- better correctness after restart
- a realistic OpenClaw integration story without pretending we control OpenClaw internals

The key simplification is to change semantics before changing infrastructure:

- first make TAP async
- then add durability
- then let OpenClaw orchestrate periodic reconciliation while optional real-time listeners stay outside OpenClaw
