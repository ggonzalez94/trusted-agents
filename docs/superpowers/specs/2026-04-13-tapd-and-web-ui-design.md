# tapd + Web UI: Surfacing Agent-to-Agent Communication

**Status:** Draft
**Date:** 2026-04-13
**Owner:** ggonzalez94
**Related:** [#32 Dedicated UI/App](https://github.com/ggonzalez94/trusted-agents/issues/32), [#54 Improve docs to include use cases](https://github.com/ggonzalez94/trusted-agents/issues/54)

## Problem

The value proposition of trusted agents is hard to demonstrate. Actions get taken — transfers complete, meetings get scheduled, grants get exchanged — but everything happens in a black box. Operators have no way to see *what their agents are doing or saying to each other*. Conversation logs exist (`packages/core/src/conversation/logger.ts`) but they're inert JSON files inspectable only via `tap conversations show`.

When showing TAP to someone, the demo collapses to "trust me, the agents talked." That's not enough. The protocol's most interesting property — autonomous agents negotiating on behalf of humans — is invisible.

We need a human-facing surface that makes agent-to-agent communication legible in real time, lets operators participate where it matters (approvals), and is built on an architecture that scales to a multi-party "Slack for agents" end vision without a future rewrite.

## Goals

1. **Make agent communication legible.** A real-time chat-style view of every conversation between this operator's agent and its peers, with structured actions (transfers, scheduling) rendered as inline rich cards.
2. **Allow human steering at the moment of decision.** Pending approvals appear as inline cards in the chat with Approve / Deny buttons, rather than as a separate approvals queue.
3. **Build the right architecture once.** The substrate should support the multi-party channel end vision (Slack for agents) without a second migration. Specifically: the data and process boundaries chosen now should still hold up when group channels, mobile clients, and remote access land later.
4. **Preserve all existing behavior** for CLI-only, OpenClaw, and Hermes users. The refactor is invisible to anyone who doesn't open the new web UI.

## Non-goals

- **Multi-party channels (the "D" end vision)** — out of scope for v1. The data model stays 1:1 (`connectionId`-keyed) and the UI has a placeholder for channels but no functionality.
- **"Compose a message as my agent" write path** — out of scope. The composer is read-only with placeholder text in v1.
- **Remote access, OAuth, mobile apps, tunneling** — out of scope. Localhost only.
- **Direct push notifications from tapd to Telegram / SMS / desktop notify** — out of scope. Notifications stay agent-mediated through whichever host the operator runs (e.g., OpenClaw → TG via OpenClaw's own messaging layer).
- **LLM narrative synthesis** ("Explain this thread" button) — out of scope. The chat itself is the narration.
- **Multi-identity workspace switcher** — out of scope. The v1 daemon hosts one identity (whichever the active `<dataDir>` resolves to). Multi-identity is the first v2 feature.
- **Windows support** — out of scope for v1. macOS and Linux only.
- **Native Claude Code integration** — out of scope. The Claude Code skill stays CLI-only for v1.

## The user-facing experience

The mockup committed at `.superpowers/brainstorm/<session>/content/chat-metaphor.html` shows the target. Concretely:

- **A Slack-style three-pane layout.** Left rail shows the operator's identity, a list of direct connections (DMs), and a greyed-out "Channels" section telegraphing the multi-party future.
- **The main column is a chat thread** with the selected peer. Messages are chat bubbles, color-coded by direction. Outbound from the operator's agent on the right, inbound from the peer agent on the left.
- **Structured actions render as rich cards inline in the chat flow.** A transfer is a card with the amount, chain, grant that authorized it, and (when complete) the chain pill and tx hash. A scheduling proposal is a card with proposed slots and Approve / Decline buttons. Pending approvals appear as cards with action buttons in-place — the operator never leaves the thread to approve.
- **A live "Bob is composing…" indicator** is in the design but **not implemented in v1** because XMTP doesn't expose typing primitives. Live message arrival is enough to make the demo feel real.
- **The composer at the bottom is read-only** in v1, with placeholder text "Your agent speaks here — read-only in v1." It's a deliberate UI affordance for the v2 inject-as-agent feature.

For agent-to-agent chat to feel like chat, agents have to actually narrate their actions in natural language. **v1 relies on convention, not protocol enforcement.** The unified TAP skill (`skills/trusted-agents/SKILL.md`) is updated to nudge agents toward sending a `message/send` turn before an `action/request`. No protocol field is added; if a non-compliant agent jumps straight to actions, the chat will show the action card without surrounding narration. This is a soft mechanism we can tighten later if it proves insufficient.

## Architecture

### The single most important constraint

The XMTP SDK assumes exclusive ownership of its installation: a single SQLite database (`<dataDir>/xmtp/<inboxId>.db3`) that cannot be safely opened by two processes. This is what the existing `.transport.lock` file enforces. Today, transport ownership is held by whichever process happens to be running: `tap message listen`, the OpenClaw plugin, or the Hermes daemon. There can be at most one. CLI commands that need transport must wait for the owner to finish or use the owner's process surface.

This works but it's the wrong shape for the end vision. It means:

- The web UI would have to be implemented inside whichever host happens to own transport, leading to N implementations.
- A user who switches between OpenClaw and Hermes mid-day moves their UI with them.
- Multi-identity (one operator, multiple agents) becomes N parallel transport-owner processes with no unified view.
- Remote access from a phone or tablet has no architectural home.
- Approvals happen in whichever process owns transport, so any UI has to know which one to talk to.

The fix is to consolidate transport ownership in **one long-lived process per machine** and make every other process a thin client of it. This eliminates the lock contention as a multi-process problem and replaces it with a clean single-owner model.

### tapd

`tapd` is a long-lived background daemon. It owns the XMTP client, the trust store, the request journal, the conversation logs, and the in-memory event bus for one identity. It exposes a local HTTP API that every other component calls.

**Process model:**

- One `tapd` per data dir, holding the `.transport.lock` (informationally — there is now exactly one known owner).
- Auto-starts lazily on first transport-touching CLI command via a user-scoped service manager (launchctl on macOS, systemd --user on Linux), with a `nohup` + pidfile fallback if no service is registered.
- Crash-restarted by the service manager.
- Manual control via `tap daemon start | stop | restart | status | logs`.
- Single path through transport for every caller — no "embedded mode" fallback for ergonomics. The auto-start machinery makes the daemon invisible to users without introducing a parallel code path.

**Component layout inside tapd:**

```
packages/tapd/
  package.json
  src/
    bin.ts                  # entrypoint: parse args, acquire lock, start
    daemon.ts               # lifecycle, signal handling, crash recovery
    runtime.ts              # holds the single TapMessagingService, bridges events
    event-bus.ts            # in-memory pub/sub with bounded ring buffer for replay
    http/
      server.ts             # node:http on Unix socket + localhost TCP
      auth.ts               # bearer-token middleware
      routes/
        identity.ts
        contacts.ts
        conversations.ts
        pending.ts
        notifications.ts    # drain endpoint for host plugins
        events.ts           # SSE stream
        assets.ts           # static serving for packages/ui/out
    service/
      detect.ts             # which service manager is available
      macos.ts              # launchctl install/uninstall
      linux.ts              # systemd --user install/uninstall
  assets/
    ui/                     # built copy of packages/ui/out, populated at build
  test/
```

The `event-classifier`, currently in `packages/openclaw-plugin/src/event-classifier.ts`, moves into `packages/core/src/runtime/event-classifier.ts` so tapd uses it host-agnostically.

### The web UI as a tapd client

The browser is one of several clients of tapd. It connects to tapd over localhost TCP (Unix sockets aren't reachable from the browser), authenticates with a per-process bearer token, fetches data via REST, and subscribes to live events via Server-Sent Events.

**Why SSE instead of WebSockets:** the data flow is unidirectional (server → browser) — writes go through plain REST endpoints. SSE has trivially correct reconnect-with-replay semantics via `Last-Event-ID`, no protocol upgrade, no proxy-incompatibility surprises. A WebSocket adds machinery we don't need.

**Why `output: 'export'` Next.js instead of a Next.js server:** the constraint is "one process owns transport, everyone else is a client." A Next.js server would be a second long-lived process. Static export gives us the full Next.js DX (App Router, TypeScript, file-based routing, layouts, components) and ships as plain HTML/JS files that tapd serves directly. Caveat: Next.js dynamic file routes require `generateStaticParams` at build time, which we can't provide for user data like `connectionId`. The UI uses **search params and client state** for thread navigation (`/dm?id=...`) — effectively a SPA running from `/`.

**Layout:**

```
packages/ui/
  package.json              # next 15, react 19 (App Router default), tailwind, shadcn/ui, swr
  next.config.mjs           # { output: 'export', images: { unoptimized: true } }
  tailwind.config.ts
  tsconfig.json
  app/
    layout.tsx              # root layout, theme, fonts, token bootstrap from URL hash
    page.tsx                # inbox; client-side selects active dm via ?id=
  components/
    chat/
      Thread.tsx
      MessageBubble.tsx
      ActionCard.tsx        # variants: transfer, scheduling, grant
      Composer.tsx          # read-only in v1
      TypingIndicator.tsx   # built but hidden in v1
    rail/
      Sidebar.tsx
      IdentityHeader.tsx
      DmList.tsx
      ChannelsPreview.tsx   # greyed-out placeholder for D
    ui/                     # shadcn primitives we own and theme
  lib/
    api.ts                  # typed REST client for tapd
    events.ts               # SSE subscription, types, SWR cache mutators
    types.ts                # event union, message shapes
    format.ts               # address/tokenId/chain formatters
  public/
```

**Stack details:**

- **Next.js 15** (current stable; Next.js 16 is canary at the time of writing). App Router. React 19 features available via App Router's bundled React.
- **Tailwind CSS** for styling.
- **shadcn/ui** for accessible base primitives we theme ourselves. Avoids the generic-AI-aesthetic trap because we write all the actual visuals.
- **SWR** for REST data fetching with cache.
- **EventSource** for SSE; new events are pushed into the SWR cache via `mutate()` so live updates flow through the same data layer as fetched data.
- **Playwright** for end-to-end tests, including a "demo flow" visual regression suite (see Testing).

**Required skill invocations during implementation:**

The following skills MUST be invoked when implementing the corresponding parts of this design. They are not invoked during brainstorming because of the brainstorming skill's hard-gate rule, but are mandatory at implementation time:

- **`frontend-design:frontend-design`** when building any visual component in `packages/ui`. This is the design quality contract — without it, the UI defaults to generic AI aesthetics.
- **`vercel-react-best-practices`** when writing or refactoring any React/Next.js code in `packages/ui`. Performance and correctness contract.
- **`skill-creator`** when modifying `skills/trusted-agents/SKILL.md` or any related skill files. Skill changes are not free-form edits.

### Why this architecture extends to the end vision

The "D" end vision is multi-party channels — Slack for agents — where humans and multiple agents can converse in shared topics. The architecture chosen here makes that addition incremental rather than transformative:

- The web UI surface is already shaped like Slack. The greyed-out Channels section becomes functional. No layout rewrite.
- The data substrate becomes a queryable durable event log (see v2 plan), at which point group conversations are just "events with multiple participants in their `connectionId` field."
- Remote access becomes one tunnel away. The HTTP API is already the abstraction.
- Mobile clients are HTTP clients of tapd, exactly like the web UI is.
- Multi-identity is "tapd holds N `TapMessagingService` instances" — the API gains an identity selector and the UI gains a workspace switcher.

None of these requires a process-model change. None requires a protocol change. The cost we pay now (consolidating transport ownership in one process, building the HTTP layer) is the cost we'd have to pay anyway to reach the end vision. We pay it once.

## HTTP API surface

### Conventions

- All paths under `/api/`. Version pinned via `Accept: application/vnd.tap.v1+json` (default if absent).
- JSON request and response bodies. ISO-8601 timestamps. CAIP-2 chain IDs.
- Errors: `{ "error": { "code": "string", "message": "string", "details": {} } }` with appropriate HTTP status. Error codes are stable, messages are human-readable.
- Pagination: cursor-based (`?cursor=...&limit=50`), max limit 200. Response includes `nextCursor`.
- All write endpoints idempotent via `Idempotency-Key` header (UUID); tapd dedupes within a 24h window using the journal.

### Auth

tapd binds two transports simultaneously:

- **Unix socket** at `<dataDir>/.tapd.sock` (mode 0600, parent dir 0700). Filesystem permissions are auth — only the user who owns the data dir can connect. Used by the CLI and host plugins.
- **Localhost TCP** on a configurable port (default 6810). Required because the browser cannot open Unix sockets. Protected by a per-process bearer token written to `<dataDir>/.tapd-token` (mode 0600), generated fresh on each tapd start. Browser obtains the token from the `tap ui` launcher, which constructs `http://localhost:<port>/?token=<token>` using the URL hash so the token never appears in browser history. The Next.js bootstrap reads the token from `location.hash`, stashes it in `sessionStorage`, and includes it as `Authorization: Bearer <token>` on every request including the SSE stream.

v2 will swap the bearer token for OAuth/passkeys when remote tunneling becomes a goal.

### Read endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/identity` | Identity tapd is hosting: `{ agentId, chain, address, displayName, dataDir }`. Probe endpoint for "is tapd alive." |
| `GET /api/contacts` | All contacts: `[{ connectionId, peerAgentId, peerName, peerChain, peerAddress, status, connectedAt, lastMessageAt }]`. Status is `active \| connecting \| revoked`. |
| `GET /api/contacts/:connectionId` | Single contact with full detail (resolved registration, grants given/received, conversation summary). |
| `GET /api/conversations` | Conversation summaries: `[{ conversationId, connectionId, peerName, lastMessageAt, lastMessagePreview, unreadCount }]`. Sorted by `lastMessageAt` desc. |
| `GET /api/conversations/:id` | Full conversation: `{ conversationId, connectionId, peer, messages: [...] }`. Messages are the unified timeline (see event schema). |
| `GET /api/conversations/:id/messages?cursor=...` | Paginated messages, newest-first. For thread scrollback. |
| `GET /api/pending` | All pending items needing operator decision: `[{ id, type, peer, summary, payload, deadline, createdAt }]`. Type is `transfer \| scheduling \| grant-request`. Sourced from the request journal + apps state. |
| `GET /api/notifications/drain` | **Host-plugin-only.** Drains the notification queue for context injection. Returns the same shape the OpenClaw plugin uses today. Idempotent within a single drain ID; subsequent drains return empty until new events arrive. |
| `GET /api/events/stream` | **SSE.** Live event stream. See event schema below. |

### Write endpoints (v1 surface)

| Endpoint | Effect |
|---|---|
| `POST /api/pending/:id/approve` | Body: `{ decision: "approve", note?: string }`. Routes to existing `resolvePending` flow with `approved: true`. |
| `POST /api/pending/:id/deny` | Body: `{ decision: "deny", reason?: string }`. Same plumbing, `approved: false`. |
| `POST /api/conversations/:id/mark-read` | Updates a per-conversation `lastReadAt` timestamp (new field, persisted in conversation log) so unread counts in the rail decay correctly. |

**Explicitly not in v1:**

- `POST /api/messages` (compose-as-agent) — deferred to v2 with the channel work.
- `POST /api/connect` — `tap connect` continues to be the user-facing surface for initiating connections.

### Daemon control endpoints

These live under a separate `/daemon/` path prefix to avoid version-locking with the API.

| Endpoint | Effect |
|---|---|
| `GET /daemon/health` | `{ status: "ok", version, uptime, transportConnected, lastSyncAt }`. |
| `POST /daemon/sync` | Triggers `runMaintenanceCycle()`. Used by `tap message sync` shim. |
| `POST /daemon/shutdown` | Graceful stop. Used by `tap daemon stop` and the service manager. |

### SSE event schema

`GET /api/events/stream` returns `text/event-stream`. Each event:

```
id: <monotonic seq>
event: <event-type>
data: <json>

```

Events are persisted in a bounded ring buffer (default 1000 entries) so a client reconnecting with `Last-Event-ID` header gets replay from where it left off. Reconnect-with-replay is critical for the demo experience: closing and reopening the tab during a handshake should not drop any visible state.

All payloads share the envelope `{ id, type, occurredAt, identityAgentId }`:

| Event | Payload |
|---|---|
| `message.received` | `{ conversationId, connectionId, peer, messageId, text, scope }` — natural-language `message/send` arrived |
| `message.sent` | same shape, outbound |
| `action.requested` | `{ conversationId, connectionId, peer, requestId, kind: "transfer" \| "scheduling" \| "grant", payload, direction }` |
| `action.completed` | `{ conversationId, requestId, kind, result, txHash?, completedAt }` |
| `action.failed` | `{ conversationId, requestId, kind, error }` |
| `action.pending` | `{ conversationId, requestId, kind, payload, awaitingDecision: true }` — emitted when an inbound action is parked awaiting operator approval. The UI uses this to render the inline approval card. |
| `pending.resolved` | `{ requestId, decision, decidedBy: "operator" \| "auto-grant" }` |
| `connection.requested` | `{ requestId, peerAgentId, peerChain, direction }` |
| `connection.established` | `{ connectionId, peer }` — fires after the contact is written `active` |
| `connection.failed` | `{ requestId, error }` |
| `contact.updated` | `{ connectionId, status, fields }` — generic contact mutation, drives rail re-render |
| `daemon.status` | `{ transportConnected, lastSyncAt }` — heartbeat / health pulse, ~1 per 30s |

**Two important properties of this set:**

1. **Every event is sourced from `TapMessagingService.emitEvent`.** The event-classifier moves into core, the emit hook is typed, and tapd subscribes once. The OpenClaw plugin's notification drain and the web UI both see the same events from the same code path. No two-source-of-truth bugs.
2. **Events are derived, not authoritative.** The journal and conversation logs remain the source of truth for state. The event bus is a notification mechanism — clients use it to know *when* to re-fetch (or to update local cache optimistically), but a fresh client always rehydrates from the REST endpoints first. Ring buffer replay is for "I missed events while disconnected," not "I'm starting fresh."

### Event lifecycle for a transfer (worked example)

**Outbound transfer initiated by the operator:**

1. Operator runs `tap transfer --to bob --amount 10`. CLI POSTs to tapd's transfer endpoint.
2. tapd builds `action/request`, sends via XMTP, emits `action.requested {kind: "transfer", direction: "outbound", ...}`. UI renders an outgoing card with status "sending."
3. Bob's side returns `action/result`. tapd receives, emits `action.completed {requestId, result, txHash}`. UI updates the existing card to "✓ confirmed on-chain."
4. Bob's agent sends a follow-up `message/send`. tapd logs to conversation, emits `message.received`. UI inserts a chat bubble below the card.

**Inbound transfer request (the magic moment):**

1. Inbound `action/request` arrives at tapd. Grant-matching finds no match. `decideTransfer` returns `null`, the request is parked in the journal as pending.
2. tapd emits `action.pending {kind: "transfer", payload, awaitingDecision: true}`. UI inserts an inline action card with [Approve][Deny] buttons.
3. Operator clicks Approve in the browser. UI POSTs `/api/pending/:id/approve`.
4. tapd routes to existing `resolvePending` with `approved: true`. The transport handler executes the transfer. tapd emits `pending.resolved {decidedBy: "operator"}` and then `action.completed {kind: "transfer", txHash}`.
5. UI updates the card: removes buttons, shows the chain pill and tx hash.

The whole flow is observable from the browser without additional state machine logic in the UI. Every state transition is an event.

## Storage: what stays, what changes, what's planned for v2

### v1: keep journal and conversation logs as today

Both stores have legitimate roles in the tapd world:

**The journal (`request-journal.json`)** does five things today:

1. Dedupe — has this `requestId` already been processed? Required because XMTP delivery is at-least-once.
2. In-flight state — outbound request sent, awaiting response. Required for crash recovery.
3. Reconciliation cursor — used by `runMaintenanceCycle`.
4. `queued` intents — command intents waiting for the transport owner to pick them up.
5. Audit / debug — `tap journal show`, `lastError` metadata.

In the tapd world, **#4 disappears.** The `queued` state was a workaround for the multi-process world. With one process always owning transport, no one needs to enqueue intents for someone else to pick up. The CLI calls tapd over HTTP and either tapd processes the request immediately or returns an error. There is no "pick this up when you can."

#1, #2, #3, #5 remain necessary. The journal stays as `request-journal.json`, sheds the `queued` state via a one-time migration on first tapd startup, and continues to be written atomically by the single tapd process.

**Conversation logs (`conversations/<id>.json`)** are the durable per-peer history. The event bus is in-memory and bounded (1000-entry ring buffer for SSE replay) — it cannot serve as long-term history. Conversation logs continue to be the source of `tap conversations show`, the markdown transcript, and the UI's `GET /api/conversations/:id` endpoint.

### Mitigation for cross-process file writes

Today both the CLI and any host plugin can write to the same files in `<dataDir>`. The existing `AsyncMutex` + atomic-write pattern in `FileTrustStore`, `FileConversationLogger`, and `FileRequestJournal` protects against concurrent writes within a single process but not across processes. With tapd running, a CLI command that mutates the trust store or the ledger races with tapd writes to the same file.

**Resolution:**

- **Write-shaped local commands** (`contacts-remove`, `permissions-revoke`) route through tapd over HTTP when tapd is running. They become thin tapd clients, exactly like the transport-touching commands. This eliminates the cross-process write race for mutations.
- **Read-shaped local commands** (`contacts-list`, `journal-show`, `conversations-show`) continue to read files directly. Reading a file that someone else is atomically rewriting via `tmp + rename` is safe — at worst you read a slightly stale snapshot.

This is a small but real correctness improvement that the refactor enables.

### v2: storage substrate migration (the next thing we tackle)

When we ship multi-party channels (the "D" end vision), three changes happen together. Doing them in one migration keeps the breaking change to a single release:

1. **Migrate to SQLite** as the storage backend for messages and events. New file: `<dataDir>/tapd.db`. Per-conversation JSON files and `request-journal.json` are one-way migrated by tapd on first startup of the new version. The migration is idempotent and safe to re-run.
2. **Collapse the conversation log into a durable event log.** The current conversation log is a denormalized view of "things that happened in a thread" — it overlaps significantly with the event stream. In v2, the event log becomes the single source of truth, and conversation views become indexed queries (`SELECT … WHERE conversationId = ? ORDER BY occurredAt`). Markdown transcript export becomes a renderer over the event log. The `IConversationLogger` interface is removed.
3. **Introduce the channel primitive.** `connectionId` becomes one flavor of `channelId`. A 1:1 conversation is a channel with two participants; a group channel is a channel with three or more. The wire protocol gains a channel addressing mechanism (TBD in v2 design). The web UI's greyed-out Channels section becomes functional.

These three changes are mutually-reinforcing: SQLite makes the event log queryable, the event log unifies storage, and the channel primitive justifies the migration cost. They should be designed together as the v2 spec.

**v2 spec is the next thing to write after v1 ships.** Owners of v2: tracked separately. The v1 design is intentionally non-binding on the v2 storage choices except at the API boundary, which stays stable.

## Notifications: agent-mediated, not direct

A first-principles correction on notifications: tapd does NOT push notifications directly to humans (Telegram, SMS, push, desktop notify) in v1. There are two distinct notification categories, and v1 only does the first:

**Category A — agent-mediated, host-specific (the existing flow, preserved).**

1. Inbound TAP message arrives at tapd's `TapMessagingService`.
2. Event classifier (now in core, used by tapd) buckets it (`auto-handle`, `escalate`, `notify`) and pushes to the in-memory notification queue.
3. The host plugin (OpenClaw or Hermes) runs a pre-prompt hook that drains the queue via `GET /api/notifications/drain` and prepends the result to the agent's context as `[TAP Notifications]`.
4. The host's agent reads the context, decides whether to tell the human, and — if yes — sends a message through the host's *own* messaging layer (OpenClaw's TG integration, Hermes's chat surface, etc.).

tapd never touches Telegram. The TG integration is OpenClaw's, not TAP's. tapd's role ends at "wake the agent's context via the drain endpoint." This is unchanged from today; the only difference is that the queue lives in tapd instead of in the plugin's own registry.

**Category B — direct push from tapd to a human channel.** Out of scope for v1. Possibly out of scope forever — it has real privacy and trust implications and competes in spirit with letting the agent speak for the operator. Not designed here.

The web UI is **not a notification sink at all.** It's a live view of the same event stream. Inbound message → SSE → chat bubble in the open browser tab. It runs in parallel to the agent-wake pathway, not as a replacement.

## Client refactors

Each existing package gains a clear delta. The end state preserves all current user-facing behavior; the architecture underneath shifts.

### `packages/cli` — splits into local and tapd-client commands

Commands split by whether they need transport.

**Stay purely local (no tapd, no HTTP):**

```
init          register      install       remove       migrate-wallet
config-show   config-set
identity-show identity-resolve
contacts-list contacts-show
conversations-list conversations-show
journal-list  journal-show
permissions-show
balance       calendar-setup calendar-check
invite-create
app           hermes
```

These commands read data dir files directly using existing core stores. They do not depend on tapd and stay fast (no process hop).

**Route through tapd over HTTP when tapd is running (write-shaped, for cross-process safety):**

```
contacts-remove
permissions-revoke
```

When tapd is not running, these commands fall back to writing the files directly with the existing atomic-write pattern. When tapd is running, they POST to tapd to perform the same mutation. This eliminates cross-process write races.

**Become tapd HTTP clients (transport-touching):**

```
send                    request-funds
connect                 transfer
publish-grants          request-grants
request-meeting         respond-meeting   cancel-meeting
message-send            message-listen    message-sync
permissions-update
```

Each of these becomes ~40 lines: parse args, build request body, POST to tapd, format response. The current implementations move into tapd's HTTP route handlers.

**`tap message listen` semantics change.** Today it owns transport. In the new world, listening happens inside tapd. `tap message listen` becomes a debug command that does `GET /api/events/stream`, formats events to stdout, and runs until Ctrl-C. Functionally it's "tail tapd's event bus." Power users and CI tests can still use it, but it no longer owns transport. **This is a breaking change to the command's behavior** and gets called out in release notes.

**New commands:**

```
tap daemon start | stop | restart | status | logs
tap ui                                    # opens the browser at the tapd URL
```

`tap ui` is a thin convenience wrapper: ensure tapd is running, read the bearer token from `<dataDir>/.tapd-token`, construct `http://localhost:<port>/#token=<token>`, and open it via the system "open URL" command. The token is in the URL hash (not the query string) so it never appears in browser history. The Next.js app's bootstrap reads the token from `location.hash` and stashes it in `sessionStorage`.

**Lazy-start logic** lives in a new file `packages/cli/src/lib/tapd-client.ts`. Every transport-touching command imports it. The flow:

1. Try to connect to tapd via the Unix socket. If `GET /daemon/health` returns OK, proceed.
2. Otherwise, check whether a service is registered. If yes, use the service manager to start it (`launchctl start` / `systemctl --user start`) and wait for the socket (~500ms).
3. Otherwise, fall back to a `nohup` spawn writing a pidfile to `<dataDir>/.tapd.pid`. Same wait.
4. If both paths fail, return a clear error: "tapd could not be started — run `tap daemon start` for details."

**Significantly changed files:**

- `packages/cli/src/lib/cli-runtime.ts` — currently constructs `TapMessagingService`. Becomes a much smaller helper that returns either a tapd HTTP client (for transport-touching commands) or direct file-store handles (for local commands).
- `packages/cli/src/lib/context.ts` — the transport-touching paths (XmtpTransport construction) move to tapd. Context shrinks.

**No files deleted from `packages/cli`.** Everything either stays or shrinks.

### `packages/openclaw-plugin` — shrinks ~90%

The biggest single refactor in this design. Today the plugin is a full TAP host: it instantiates `TapMessagingService` per identity, runs the event classifier, manages the notification queue, owns the registry of running runtimes, and exposes the `tap_gateway` tool. Almost all of that disappears.

**Files deleted:**

- `packages/openclaw-plugin/src/registry.ts` — `OpenClawTapRegistry`. Its job was holding `TapMessagingService` per identity. tapd does that now.
- `packages/openclaw-plugin/src/event-classifier.ts` — moves to `packages/core/src/runtime/event-classifier.ts` so tapd uses it.
- `packages/openclaw-plugin/src/notification-queue.ts` — the queue lives in tapd.
- `packages/openclaw-plugin/src/main-session.ts` — was scoping state to OpenClaw's main session. tapd is process-global; not needed.

**Files significantly changed:**

- `packages/openclaw-plugin/src/plugin.ts` — `register()` no longer constructs a registry. `registerService` becomes a no-op (or a "verify tapd is reachable" sanity check). The `before_prompt_build` hook becomes ~30 lines:

  ```ts
  api.on("before_prompt_build", async () => {
    const notifications = await tapdClient.drainNotifications();
    if (!notifications.length) return;
    return { prependContext: formatTapNotifications(notifications) };
  });
  ```

  The formatting helper is the same code as today.

- `packages/openclaw-plugin/src/tool.ts` — `createTapGatewayTool` keeps the exact same OpenClaw tool schema (so the `tap_gateway` tool the agent calls is identical). Each action handler changes from "call into the local `TapMessagingService`" to "POST to the corresponding tapd endpoint." Schema-stable, behavior-stable, plumbing different.

- `packages/openclaw-plugin/src/config.ts` — config schema collapses. Today the plugin needs identity config, OWS wallet config, XMTP config, etc. All of that is tapd's responsibility. The plugin only needs:

  ```
  {
    tapdSocketPath?: string,    // default <dataDir>/.tapd.sock
    dataDir?: string            // default ~/.trustedagents
  }
  ```

  Optional auto-spawn flag if you want the plugin to start tapd when OpenClaw Gateway boots.

**Test surface migration.** Most of the OpenClaw plugin's existing test suite tests the classifier, the notification queue, and the registry — all of which move. These tests **don't get deleted; they get moved**:

- Classifier tests → `packages/core/test/unit/runtime/event-classifier.test.ts`
- Notification queue tests → `packages/tapd/test/unit/notification-queue.test.ts`
- Registry tests → mostly become tapd lifecycle tests in `packages/tapd/test/unit/runtime.test.ts`

The plugin's own remaining test surface is small: HTTP shim forwarding, plus a small integration test ensuring the `before_prompt_build` hook calls tapd and renders notifications.

### `packages/cli/src/hermes/` — generalize, don't rewrite

The Hermes daemon at `packages/cli/src/hermes/daemon.ts` is the prototype of `tapd`. The migration is a careful lift:

1. **Move the daemon code.** `daemon.ts`, `client.ts`, `ipc.ts`, `file-lock.ts`, `notifications.ts`, `event-classifier.ts`, `registry.ts` → `packages/tapd/src/`. Internal types renamed from `Hermes*` to `Tapd*`.
2. **Generalize the IPC schema.** Today's Hermes IPC is a JSON-line RPC for the actions Hermes needs. We extend it to be the same shape as the public HTTP API — same routes, same payloads, just over a Unix socket instead of TCP. Concretely: tapd serves HTTP on a Unix socket using node's built-in `http.createServer` listening on the socket path. One server, two transports.
3. **Add the SSE endpoint.** Today's Hermes IPC has notification draining but no live event stream. We add `/api/events/stream` to the surface so the Web UI and any future client can subscribe.
4. **Add the static asset route.** `/` and `/_next/*` serve from `packages/ui/out/` (resolved relative to the tapd binary's install location).
5. **Hermes-specific assets stay in `packages/cli`.** The Python plugin (`packages/cli/assets/hermes/plugin/`) and the Hermes startup hook (`packages/cli/assets/hermes/hook/`) remain in the CLI package because they're install-flow artifacts of `tap install --runtime hermes`. The hook script gets a one-line update: instead of starting a Hermes-specific daemon, it ensures tapd is running.

**Files deleted:** `packages/cli/src/hermes/daemon.ts`, `client.ts`, `ipc.ts`, `file-lock.ts`, `event-classifier.ts`, `registry.ts`, `notifications.ts`. They live in `packages/tapd/src/` now.

**Files unchanged:** `packages/cli/src/hermes/install.ts`, `packages/cli/src/hermes/config.ts`, `packages/cli/assets/hermes/*`. Install-time Hermes concerns.

**End-user impact for Hermes users:** functionally none. The daemon process gets renamed in `ps` output, the socket path moves from `<dataDir>/.hermes.sock` to `<dataDir>/.tapd.sock`, and they re-run `tap install --runtime hermes --upgrade` to update the startup hook. The Python plugin keeps working because the IPC schema is backward-compatible.

### `packages/sdk` — unchanged in v1

`createTapRuntime()` continues to work as today: it constructs a `TapMessagingService` directly inside the embedder's process. SDK consumers who want a long-lived TAP runtime in their own app keep getting one. No tapd dependency.

This means there are now two ways to use TAP at the SDK layer: **embedded** (today's pattern, used by SDK consumers) and **daemonized** (new, used by the CLI and host plugins via tapd's HTTP API). Both are first-class. The SDK docs make the duality explicit so users aren't confused about which to pick. A `delegateToTapd: true` option for `createTapRuntime` is a v2 consideration if there's demand.

### `packages/core` — small, surgical changes

- **Add `packages/core/src/runtime/event-classifier.ts`** — moved verbatim from `openclaw-plugin/src/event-classifier.ts`. No logic change; the function is already host-agnostic.
- **Add typed event payload** for `TapMessagingService.emitEvent`. Today it's `Record<string, unknown>`; we type it as a discriminated union matching the SSE event schema. Backward-compatible because the existing OpenClaw plugin shape is a subset.
- **No changes** to identity, transport, trust, or protocol modules. These are all correctly host-agnostic already.

### `skills/trusted-agents/SKILL.md` — three updates

The unified skill file gets updated in three small places. **All edits to skill files MUST go through `skill-creator`.**

1. **Architecture section** — add a paragraph noting that tapd is the long-lived process that owns transport, and that CLI commands and host plugins are clients of it. Mention the `tap daemon` commands and `tap ui`.
2. **OpenClaw / Hermes sections** — simplify them to reflect the thinner plugins. Most of the host-specific guidance shrinks because tapd is the same everywhere.
3. **Narration nudge** — add a "Conversational style" subsection prompting agents to send a `message/send` turn before an `action/request` to give the operator narration context. This is the soft mechanism that makes the chat UI legible without a protocol change.

The skill file gets copied to OpenClaw plugin and Hermes assets at build time exactly as today. No changes to the build copy machinery.

### Build / packaging

- `packages/ui` builds with `next build` → outputs `packages/ui/out/`.
- `packages/tapd` build script copies `packages/ui/out/` into `packages/tapd/dist/ui/` so the daemon ships with the UI bundle inline.
- Workspace root `bun run build` builds in dependency order: `core → ui → tapd → cli → openclaw-plugin → sdk → app-transfer → app-scheduling`.
- `tap install` ensures the tapd binary and the bundled UI are on disk and registers the service.

## Migration, rollout, testing

### Rollout to existing user populations

**CLI-only users.** Lowest risk. They don't run a long-lived host. After the refactor, the first time they run a transport-touching command, tapd auto-starts. They never notice the daemon. Their existing `<dataDir>` is read as-is — no migration of contacts, conversations, or journal needed because tapd reads from the same files.

**Hermes users.** Medium risk. The migration is: stop the old daemon, start tapd, update the hook script. Concrete migration command: `tap install --runtime hermes --upgrade` (idempotent). The hook script change is one line. The Python plugin keeps working because the IPC schema is backward-compatible (same routes, same payloads, the socket file moved).

**OpenClaw users.** Highest risk. The plugin is being almost-entirely rewritten. Migration: pull the new plugin version, run OpenClaw Gateway. The plugin notices tapd isn't running, starts it (or fails with a clear "run `tap daemon start`" error), and proceeds. Existing data dir state (contacts, journal, conversations) is read as-is by tapd. Worst case: the plugin starts but tapd can't, and the agent loses TAP capability for that session — same failure mode as today's "TAP runs in degraded mode."

**Data migration: nothing.** No file shapes change in v1. The journal sheds its `queued` state but old entries with `queued` get migrated to either `pending` (if they have a request payload) or dropped (if they're stale command intents) on first tapd startup. This migration runs through the same `runLegacyStateMigrations()` mechanism that already exists in `TapMessagingService.start()`. We add one migration entry, not a new system.

**Versioning.** The release that ships tapd stays in the `0.2.x` line — current is `0.2.0-beta.6`, target `0.2.1` (or `0.2.0` stable when we cut the beta). No minor bump because the wire protocol is unchanged and beta versions allow architectural shifts. Release notes call out:

- The new daemon and where its socket lives
- That OpenClaw users should re-pull the plugin
- That Hermes users should run the upgrade command
- That `tap message listen` semantics changed (now an SSE tail, not a transport owner)
- The `tap ui` command and how to launch the dashboard

**Backward compatibility we explicitly do NOT promise:**

- Anything other than the wire protocol over XMTP. File paths, internal IPC schemas, plugin internals, CLI command flags — all allowed to change. The release notes are the contract.

**Backward compatibility we explicitly DO promise:**

- The wire protocol over XMTP. Cross-implementation agents continue to interoperate.

### Sequencing the work

Six phases, ordered to keep the tree green and minimize the duration any user sees half-broken behavior. Estimated total: ~4 weeks of focused work. Phases 1 and 2 can overlap if there are parallel hands; everything else is mostly sequential.

**Phase 1 — `packages/tapd` greenfield (1 week).** No existing user impact.

1. Create `packages/tapd/` workspace with empty scaffolding.
2. Lift `packages/cli/src/hermes/daemon.ts` and friends into `packages/tapd/src/`. Rename types, keep IPC behavior identical. **Important:** `packages/cli/src/hermes/` continues to exist during this phase. We're copying, not moving, until Phase 4. This is so Hermes users keep working while tapd is built out.
3. Move `event-classifier.ts` from `openclaw-plugin` into `packages/core/src/runtime/`. Update `openclaw-plugin` to import from core. No behavior change.
4. Add the typed event payload to `TapMessagingService.emitEvent`. Existing consumers keep working because the shape is a strict subset of `Record<string, unknown>`.
5. Add the HTTP server (raw `node:http` for zero-dep simplicity), routes for `/api/identity`, `/api/contacts`, `/api/conversations*`, `/api/pending`, `/api/notifications/drain`, `/api/events/stream`. Each route is a thin shim over existing core stores or in-memory state.
6. Add the bearer-token auth middleware and the Unix-socket / TCP dual-bind.
7. Add the `bin.ts` entrypoint, lock acquisition, signal handling.
8. Unit-test each route in isolation against a mocked `TapMessagingService`. Integration test: spin up tapd against a temp data dir, hit endpoints over HTTP, verify responses.

End of Phase 1: tapd binary builds and runs. No user is affected. Nothing else in the repo references it yet.

**Phase 2 — `packages/ui` Next.js app (1 week).** Isolated from the rest.

1. Create `packages/ui/` Next.js 15 project with App Router, `output: 'export'`, Tailwind, shadcn/ui primitives.
2. Stub the tapd HTTP API in a mock layer so the UI can be developed without a running daemon. The mock returns the canonical fixture conversations from the brainstorm mockup.
3. Build out the components: Sidebar with DM list and greyed-out Channels, Thread with chat bubbles, ActionCard for transfers and scheduling, the read-only Composer.
4. Wire SWR for REST endpoints and EventSource for the SSE stream. State updates from SSE flow into the SWR cache via `mutate()`.
5. **Invoke `frontend-design:frontend-design` and `vercel-react-best-practices`** during this phase. Design quality and React patterns are set here.
6. Build → static export → manually serve `out/` and click through against a real running tapd from Phase 1.
7. Playwright smoke tests for the golden path (open inbox → click DM → see action card → click Approve → see status update).

End of Phase 2: a running web UI talks to a running tapd against a test data dir. No production users affected; host plugins still on old code paths.

**Phase 3 — CLI thin-client (3-5 days).**

1. Add `lib/tapd-client.ts` — the HTTP client + lazy-start logic.
2. Add `tap daemon start | stop | restart | status | logs` and `tap ui` commands.
3. Migrate transport-touching commands one at a time, simplest first: `message-send` → `connect` → `transfer` → `request-funds` → `request-meeting` → `respond-meeting` → `cancel-meeting` → `publish-grants` → `request-grants` → `permissions-update` → `message-listen` → `message-sync`.
4. **`message-listen` semantics change** — its own commit with a release-notes entry. Most likely command to surprise scripts.
5. After each command migrates, run the existing CLI test suite. Most tests should keep passing because they exercise behavior, not transport plumbing. Tests that mock `XmtpTransport` directly switch to mocking the tapd HTTP layer.
6. Update e2e mock and live tests to launch tapd as part of test setup. The shared scenario list in `packages/cli/test/e2e/scenarios.ts` doesn't change — scenarios are protocol-level, not transport-plumbing-level.

End of Phase 3: the CLI works against tapd. CLI-only users see no behavior change. OpenClaw and Hermes are still on old paths.

**Phase 4 — Hermes migration (2-3 days).**

1. Update `packages/cli/assets/hermes/hook/` startup hook to ensure `tapd` is running instead of starting the old daemon.
2. Update the Python plugin to point at `<dataDir>/.tapd.sock` instead of `.hermes.sock`.
3. Delete `packages/cli/src/hermes/daemon.ts` and friends — the canonical copy now lives in `packages/tapd/`. Keep `packages/cli/src/hermes/install.ts` and `config.ts` because they're install-time concerns.
4. Run the Hermes integration tests; verify the `tap install --runtime hermes --upgrade` migration command leaves a working setup.

End of Phase 4: Hermes users are on tapd. Old Hermes daemon code is gone.

**Phase 5 — OpenClaw plugin refactor (1 week).**

1. Delete `OpenClawTapRegistry`, the local notification queue, the local main-session helper.
2. Rewrite `plugin.ts` against the tapd HTTP client. The `before_prompt_build` hook becomes the 30-line drain-and-format function.
3. Rewrite `tool.ts` action handlers as HTTP calls to tapd routes (one-to-one mapping).
4. Shrink `config.ts` to the `tapdSocketPath` / `dataDir` fields.
5. Move classifier and notification-queue tests out of `packages/openclaw-plugin/test/` into `packages/core/test/` and `packages/tapd/test/`. The plugin's remaining test surface is the HTTP shim and the hook.
6. Verify the OpenClaw integration test scenario end-to-end.
7. **Invoke `skill-creator`** for the SKILL.md updates (architecture paragraph, OpenClaw/Hermes section simplifications, narration nudge).

End of Phase 5: OpenClaw plugin is on tapd. Plugin is ~10% of its previous size. Behavior identical to users.

**Phase 6 — release prep (2-3 days).**

1. Bump version to `0.2.1` (staying in the 0.2.x line).
2. Update `CHANGELOG.md` with architecture migration notes, breaking changes, and migration commands.
3. Run the full test matrix: unit, integration, mocked e2e, live e2e against mainnet, Hermes integration, OpenClaw integration.
4. Update `Agents.md` to reflect the tapd-centric architecture and the "thin plugin, thin CLI, fat daemon" rule.
5. Cut the release.

### Testing strategy

**Unit tests (per package).**

- `packages/core` — existing tests stay. New tests for the moved event classifier (relocated from OpenClaw tests).
- `packages/tapd` — route-level tests against a mocked `TapMessagingService`. Lifecycle tests (start, stop, signal handling, lock acquisition). Event bus replay tests (reconnect with `Last-Event-ID`).
- `packages/ui` — component tests via React Testing Library. Snapshot tests for the chat bubble, action card, sidebar variants. **Visual regression** via Playwright + screenshot comparison for the demo flow — the chat-metaphor mockup is the visual contract.
- `packages/cli` — existing command tests stay, with mocks switched from `XmtpTransport` to the tapd HTTP layer.
- `packages/openclaw-plugin` — small surface, one or two HTTP shim tests plus a hook integration test.

**Integration tests.**

- **`packages/tapd` end-to-end tests** spin up tapd against a temp data dir and exercise the full HTTP API and SSE stream against a real (in-memory) `TapMessagingService` with a stubbed transport.
- **CLI ↔ tapd integration tests** spin up tapd in a subprocess and run real CLI commands against it. Verifies lazy-start, HTTP plumbing, lock handoff, and failure modes.
- **UI ↔ tapd integration tests** via Playwright: launch tapd, build the UI, serve it, drive the browser through the demo scenarios. Most expensive tests, most valuable for catching regressions in the demo experience.

**E2E tests** (`e2e-mock.test.ts`, `e2e-live.test.ts`).

- Both files keep their shared scenarios. Test setup gains a "start tapd" step. CLI commands inside the scenarios continue to look like CLI commands; under the hood they're talking to tapd.
- This is the most important regression coverage — these tests verify the wire protocol still works end-to-end across two independent processes.
- Live e2e against mainnet runs as the release gate. Phase 6 of the rollout depends on it being green.

**New: visual demo regression test.**

Because v1 is fundamentally about the demo working, a Playwright-based "demo script" test:

1. Starts tapd against a temp data dir.
2. Seeds two TAP runtimes (Alice, Bob) connected via the loopback transport.
3. Drives Bob to send a `message/send` ("Want $10 for sandwich?"), then an `action/request` (transfer 10 USDC).
4. Opens the UI in a browser, screenshots the chat thread and the action card.
5. Clicks Approve, screenshots the post-approval state.
6. Diffs against committed reference screenshots.

This catches refactors that break the demo flow before a human notices. Runs in CI on every PR.

### Risk register

1. **Concurrent file writes between local CLI commands and tapd.** Mitigated by routing write-shaped local commands (`contacts-remove`, `permissions-revoke`) through tapd when it's running.
2. **OpenClaw plugin behavioral drift during the rewrite.** Mitigated by a freeze-then-rewrite sequence with behavior tests as the contract. Tests don't change during the refactor; the green test suite is the regression gate.
3. **tapd lifecycle on macOS launchctl edge cases.** launchctl has surprising behaviors around per-user agents, login state, and PATH. Mitigated by a fallback `nohup` path and a clear `tap daemon logs` command. Test on a clean macOS user account before release.

## Open questions

None blocking the implementation plan. All architectural decisions have been made. The following are deliberately deferred and documented as such:

- **Multi-identity workspace switcher** — first v2 feature. Requires a small API change (identity selector) and a UI workspace switcher. No protocol change.
- **`POST /api/messages` (compose-as-agent write path)** — v2 with the channel work. The composer is read-only in v1.
- **Direct push notifications from tapd** (Category B) — possibly never. Requires more thought about the privacy and trust model.
- **Native Claude Code integration via MCP** — v2 consideration. Would let `tapd` expose itself as an MCP server so Claude Code talks to it without any plugin glue.
- **SQLite migration + event log unification + channel primitive** — the v2 spec. This is the next thing to write after v1 ships.
- **Windows support** — needs a separate design pass. Service manager story (Windows service vs Task Scheduler vs raw process), socket transport (Windows named pipes vs TCP-only), CLI ergonomics.

## Required skill invocations during implementation

These are not invoked during brainstorming because of the brainstorming skill's hard-gate rule. They are mandatory at implementation time:

- **`frontend-design:frontend-design`** — when building any visual component in `packages/ui`.
- **`vercel-react-best-practices`** — when writing or refactoring any React/Next.js code in `packages/ui`.
- **`skill-creator`** — when modifying `skills/trusted-agents/SKILL.md` or any related skill files.

## Appendix: the chat metaphor mockup

The visual target lives at `.superpowers/brainstorm/<session>/content/chat-metaphor.html`. Key elements that v1 must reproduce:

- Three-pane Slack-style layout (sidebar, thread, action area).
- Identity header in the sidebar showing the operator's agent ID and chain.
- DM list with avatar, peer name, unread dot.
- Greyed-out "Channels" section telegraphing the multi-party future.
- Chat bubbles colored by direction with timestamps.
- Inline action cards for transfers (amount, chain, grant, status, tx hash) and scheduling (proposed slots, Approve / Decline buttons).
- Read-only composer with placeholder text.
- Live-feeling updates (new messages and cards appear without a manual refresh).
