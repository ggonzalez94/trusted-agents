# TAP Open Protocol Architecture

> Transform TAP from a product with specific capabilities into infrastructure with an open action protocol.

## Context

TAP is a coordination and trust layer for agents. It sits between lower-level primitives (transport, identity, payments) and an unbounded app layer above. Today, the protocol supports a fixed set of actions (transfer, scheduling) hardcoded into `TapMessagingService`. This design opens the protocol so that any number of apps can be built on top — peer-to-peer betting, shared expense tracking, marketplace offers, or anything else — without modifying core.

### Terminology

| Concept | Name | Description |
|---|---|---|
| TAP runtime | **Runtime** | The core engine: identity, trust, transport, message routing |
| Capabilities built on TAP | **TAP apps** | Installable modules that handle specific action types |
| Processes that run TAP | **TAP hosts** | CLI, OpenClaw Gateway, custom servers that embed a runtime |

### Package naming convention

- First-party apps: `@trustedagents/app-<name>` (e.g., `@trustedagents/app-transfer`)
- Third-party apps: `tap-app-<name>` (e.g., `tap-app-betting`)
- `tap app install betting` resolves to `tap-app-betting` automatically

---

## 1. TAP App Interface

The contract every TAP app must satisfy.

### App definition

```ts
interface TapApp {
  id: string;                                  // unique identifier: "transfer", "betting"
  name: string;                                // human-readable: "Peer-to-Peer Betting"
  version: string;                             // semver
  actions: Record<string, TapActionHandler>;   // action type -> handler
  grantScopes?: string[];                      // scopes this app understands for grants
}

interface TapActionHandler {
  inputSchema?: Record<string, unknown>;       // JSON Schema for validation
  handler: (ctx: TapActionContext) => Promise<TapActionResult>;
}

interface TapActionResult {
  success: boolean;
  data?: Record<string, unknown>;              // response payload in action/result
  error?: { code: string; message: string };
}

function defineTapApp(app: TapApp): TapApp;
```

### Action context (the primitives apps receive)

```ts
interface TapActionContext {
  // Identity
  self: {
    agentId: number;
    chain: string;
    address: `0x${string}`;
  };

  // Peer relationship
  peer: {
    contact: ReadonlyContact;
    grantsFromPeer: PermissionGrant[];   // filtered to this app's grantScopes
    grantsToPeer: PermissionGrant[];     // filtered to this app's grantScopes
  };

  // The inbound action
  payload: Record<string, unknown>;
  text?: string;

  // Capabilities
  messaging: {
    reply(text: string): Promise<void>;
    send(peerId: number, text: string): Promise<void>;
  };

  payments: {
    request(params: PaymentRequestParams): Promise<{ requestId: string }>;
    execute(params: TransferExecuteParams): Promise<{ txHash: string }>;
  };

  storage: TapAppStorage;

  events: {
    emit(event: { type: string; summary: string; data?: Record<string, unknown> }): void;
  };

  log: {
    append(entry: { text: string; direction: "inbound" | "outbound" }): Promise<void>;
  };
}
```

### Payment parameters

```ts
interface PaymentRequestParams {
  asset: string;
  amount: string;
  chain: string;
  toAddress: `0x${string}`;
  note?: string;
}

interface TransferExecuteParams {
  asset: string;
  amount: string;
  chain: string;
  toAddress: `0x${string}`;
  note?: string;
}
```

### App-scoped storage

```ts
interface TapAppStorage {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<Record<string, unknown>>;
}
```

Backed by `<dataDir>/apps/<appId>/state.json`. Each app gets an isolated namespace. Atomic writes follow the same `tmp + rename` pattern as `FileTrustStore`.

### What apps cannot access

| Excluded | Reason |
|---|---|
| `TapMessagingService` | Apps are handlers inside the service, not peers of it |
| Trust store mutations | Apps read contacts but don't add/remove/modify them |
| Transport layer | Apps don't know about XMTP |
| OWS keys, signing | The runtime signs on apps' behalf |
| Other apps' storage | Isolation by design |
| Other apps' grants | Apps only see grants for their declared scopes |
| Request journal | Internal dedup/reconciliation state |
| Data dir paths | Apps use the storage primitive |

---

## 2. App Manifest and Lifecycle

### Manifest format

File: `<dataDir>/apps.json`

```json
{
  "apps": {
    "transfer": {
      "package": "@trustedagents/app-transfer",
      "entryPoint": "@trustedagents/app-transfer",
      "installedAt": "2026-03-30T00:00:00.000Z",
      "status": "active"
    },
    "scheduling": {
      "package": "@trustedagents/app-scheduling",
      "entryPoint": "@trustedagents/app-scheduling",
      "installedAt": "2026-03-30T00:00:00.000Z",
      "status": "active"
    }
  }
}
```

### Install flow

1. `tap app install betting` (resolves to `tap-app-betting`)
2. npm installs the package
3. `import()`s the entry point to validate it exports a valid `TapApp`
4. Checks for action type conflicts with already-installed apps (two apps cannot handle the same action type)
5. If validation fails: aborts, removes package, manifest unchanged
6. If validation passes: writes entry to `apps.json`
7. App is available immediately — next inbound message for a declared action type lazy-loads it

### Remove flow

1. `tap app remove betting`
2. Removes entry from `apps.json`
3. Optionally removes app state from `<dataDir>/apps/betting/` (CLI prompts for confirmation; programmatic API accepts `removeState: boolean`, defaults to `false`)
4. Does NOT npm uninstall (avoids breaking shared dependencies; users can clean up manually)

### Default manifest

On first `tap init` (or when `apps.json` doesn't exist), the runtime creates it with `@trustedagents/app-transfer` and `@trustedagents/app-scheduling` pre-registered.

### Runtime loading

1. On startup, runtime reads `apps.json` and builds an action-type -> app-id routing table. No `import()` yet.
2. On inbound `action/request`, checks the routing table for the action type.
3. If found and not yet loaded: `import(entryPoint)`, validate, cache the module, call the handler.
4. If found and already loaded: call the handler directly.
5. If not found: send `action/result` with `error: { code: "UNSUPPORTED_ACTION", message: "No app handles this action type" }`.
6. If `import()` fails at runtime: send `action/result` with `error: { code: "APP_LOAD_FAILED" }`, log the error.

### CLI surface

```
tap app install <name>     # install from npm (resolves tap-app-<name>)
tap app remove <name>      # remove from manifest
tap app list               # show installed apps and their action types
```

---

## 3. Backward Compatibility

### Graceful degradation for unknown actions

Today, unknown `action/request` payloads throw `ValidationError("Unsupported action request payload")`, which crashes the request handler. In the new architecture:

- Unknown action types return a structured `action/result` with `error: { code: "UNSUPPORTED_ACTION" }`
- The sender's app layer receives this as a normal error response and can handle it (e.g., "Your peer doesn't support betting")
- No transport-level failure, no crash

This is a change to the existing error path in `TapMessagingService.onRequest()` (service.ts ~line 1639). The hard throw becomes a protocol-level rejection.

### Wire compatibility

The built-in apps (`app-transfer`, `app-scheduling`) produce the exact same JSON-RPC payloads as today's hardcoded logic. An agent on the new architecture and an agent on the old architecture speak the same wire protocol. No protocol version bump needed.

---

## 4. Modularizing Built-in Actions

Transfer and scheduling become real TAP app packages. They ship pre-installed but are structurally identical to third-party apps.

### `@trustedagents/app-transfer`

Extracts from `packages/core/src/runtime/service.ts`:
- `parseTransferActionRequest` / `matchesTransferGrantRequest` / `decideTransfer` / `processTransferRequest`
- Grant scope: `transfer/request`
- Uses `ctx.payments.execute` and `ctx.payments.request` from the app context
- Uses `ctx.storage` for the permission ledger (replaces the current markdown file append)
- Exports typed helpers for outbound use: `buildTransferPayload(params)`

### `@trustedagents/app-scheduling`

Extracts from `packages/core/src/runtime/service.ts` and `packages/core/src/scheduling/`:
- `SchedulingHandler` / `filterSchedulingProposalSlots` / scheduling grant matching
- Grant scope: `scheduling/request`
- Uses `ctx.storage` for scheduling state
- Calendar integration lives inside this app (scheduling-specific, not a TAP primitive)
- Exports typed helpers for outbound use: `buildSchedulingPayload(params)`

### What stays in core

| Responsibility | Why it stays |
|---|---|
| Connection protocol (`connection/*`) | Trust establishment is fundamental to TAP |
| `message/send` | Basic text messaging is a primitive |
| `permissions/update` | Grant exchange is protocol-level; core stores all grants regardless of scope (you may receive grants for apps not yet installed). Apps declare `grantScopes` to filter which grants they see in `TapActionContext`, but core does not validate scopes against installed apps |
| App registry and routing | Core infrastructure |
| All interfaces (`TransportProvider`, `ITrustStore`, etc.) | Seam definitions |
| `TapActionContext` construction | Core responsibility to build the context apps receive |

### How `TapMessagingService.onRequest()` changes

The dispatch shrinks to:

1. `connection/request` or `connection/result` or `connection/revoke` -> handle in core
2. `permissions/update` -> handle in core
3. `message/send` -> handle in core
4. `action/request` -> route to app registry (lookup action type, lazy-load app, call handler)

The ~1,700 line monolithic class loses all transfer/scheduling method code. What remains is connection management, messaging, permissions, and the app routing infrastructure.

### How hosts send app-specific actions

The SDK provides a generic `runtime.sendAction(peerId, actionType, payload)`. Apps export typed helpers:

```ts
// In a CLI command or host
import { buildTransferPayload } from "@trustedagents/app-transfer";

const payload = buildTransferPayload({ asset: "USDC", amount: "50", chain, toAddress });
await runtime.sendAction(peerId, "transfer/request", payload);
```

The SDK is app-agnostic. It knows nothing about transfers or scheduling. Apps are just libraries.

---

## 5. The SDK Package (`@trustedagents/sdk`)

The public entry point for building on TAP.

### Public API

```ts
// Runtime creation (replaces the 4-step manual composition)
const runtime = await createTapRuntime({
  dataDir: "~/.trustedagents",
  overrides?: {
    trustStore?: ITrustStore;
    conversationLogger?: IConversationLogger;
    requestJournal?: IRequestJournal;
    transport?: TransportProvider;
  }
});

// Lifecycle
await runtime.start();
await runtime.stop();
await runtime.syncOnce();

// Core protocol operations
await runtime.connect({ inviteUrl });
await runtime.sendMessage(peerId, "hello");
await runtime.publishGrants(peerId, grantSet);
await runtime.requestGrants(peerId, grantSet);

// Generic action sending (app-agnostic)
await runtime.sendAction(peerId, "bet/propose", { terms: "...", amount: "50" });

// App management
await runtime.installApp("tap-app-betting");
await runtime.removeApp("betting");
runtime.listApps();

// State inspection
runtime.getStatus();
runtime.listPendingRequests();
runtime.resolvePending(id, approve, reason);

// Event subscription
runtime.on("action:received", (event) => { ... });
runtime.on("action:result", (event) => { ... });
runtime.on("connection:request", (event) => { ... });
runtime.on("app:event", (event) => { ... });
```

### Re-exports

The SDK re-exports the types app developers need:
- `defineTapApp`, `TapApp`, `TapActionContext`, `TapActionResult`, `TapActionHandler`
- `TapAppStorage`
- `ReadonlyContact`, `PermissionGrant`
- `ITrustStore`, `IConversationLogger`, `IRequestJournal`, `TransportProvider` (for custom implementations)

### What it does NOT expose

- `TapMessagingService` directly
- Config internals (OWS keys, XMTP config, data dir paths)
- File-backed implementation classes
- Protocol message construction internals

### Package structure

```
packages/sdk/
├── src/
│   ├── index.ts           # public API barrel
│   ├── runtime.ts         # createTapRuntime, TapRuntime class
│   ├── app-loader.ts      # manifest reading, lazy import, validation
│   ├── app-context.ts     # TapActionContext construction
│   ├── installer.ts       # npm install + validate + manifest write
│   └── types.ts           # re-exported public types
├── package.json
└── tsconfig.json
```

### How the CLI changes

The CLI becomes a thin host over the SDK:

```ts
import { createTapRuntime } from "@trustedagents/sdk";

const runtime = await createTapRuntime({ dataDir });
await runtime.start();
// CLI commands call runtime methods
```

Replaces the current `buildContext` / `buildContextWithTransport` / `createCliTapMessagingService` composition. CLI-specific UX (TTY approval prompting, output formatting) is wired through runtime events or a host hooks parameter on `createTapRuntime`.

### How the OpenClaw host adapter changes

The OpenClaw plugin's `OpenClawTapRegistry.ensureRuntime()` switches from manual core composition to:

```ts
import { createTapRuntime } from "@trustedagents/sdk";

const runtime = await createTapRuntime({ dataDir, overrides: { ... } });
runtime.on("app:event", (event) => notificationQueue.push(event));
runtime.on("connection:request", (event) => deferForApproval(event));
await runtime.start();
```

The plugin remains a TAP host — it manages runtime lifecycle, wires notifications and escalation, and exposes the `tap_gateway` tool surface. But it no longer constructs core internals directly.

---

## 6. Dependency Graph

```
@trustedagents/sdk
  └── @trustedagents/core

@trustedagents/app-transfer
  └── @trustedagents/core (for types only)

@trustedagents/app-scheduling
  └── @trustedagents/core (for types only)

trusted-agents-cli
  └── @trustedagents/sdk
  └── @trustedagents/app-transfer (for outbound helpers)
  └── @trustedagents/app-scheduling (for outbound helpers)

trusted-agents-tap (OpenClaw host)
  └── @trustedagents/sdk
```

Apps depend on core for types but interact with the runtime only through `TapActionContext`. The SDK wraps core. Hosts depend on the SDK.

---

## 7. File and State Layout

```
<dataDir>/
├── config.yaml                    # agent identity, chain, OWS, XMTP config
├── contacts.json                  # trust store
├── request-journal.json           # dedup/reconciliation
├── pending-connects.json          # outbound connection state
├── ipfs-cache.json                # registration upload cache
├── apps.json                      # installed apps manifest (NEW)
├── apps/                          # app-scoped state (NEW)
│   ├── transfer/
│   │   └── state.json
│   ├── scheduling/
│   │   └── state.json
│   └── betting/                   # third-party app state
│       └── state.json
├── conversations/<id>.json        # per-peer transcripts
└── xmtp/<inboxId>.db3             # XMTP client DB
```

---

## 8. Scope Boundaries

### In scope for this design

- TAP app interface (`defineTapApp`, `TapActionContext`, all primitives)
- App manifest, install/remove lifecycle, lazy-loading
- App-scoped storage primitive
- Graceful `UNSUPPORTED_ACTION` error responses
- Extract `@trustedagents/app-transfer` from core
- Extract `@trustedagents/app-scheduling` from core
- `@trustedagents/sdk` package with `createTapRuntime` and public API
- CLI and OpenClaw host adapter migration to use SDK
- `tap app install/remove/list` CLI commands

### Out of scope

- Identity layer changes (ERC-8004 stays as-is)
- New transport implementations
- Period-based budget enforcement in grants (can be built as app logic in `approveTransfer`)
- App discovery/registry service (apps are distributed via npm)
- Per-conversation app loading
- `tap app check` diagnostic command
