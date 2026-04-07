# Hermes Support Design

## Goal

Add first-class TAP support for Hermes Agent while preserving the existing architecture:

- core remains the source of protocol and runtime behavior
- SDK remains the host-facing runtime entrypoint
- Hermes support is a thin host adapter over the SDK
- long-lived XMTP ownership stays in one dedicated process

## Hermes Constraints

Hermes is not equivalent to OpenClaw at the host boundary.

From the Hermes docs and source:

- Hermes Gateway is a single long-lived process that owns all messaging adapters, session routing, and cron execution.
- Hermes plugins are Python extensions that register tools, hooks, and CLI subcommands.
- Hermes gateway hooks can react to startup/session/agent events, but Hermes does not expose an OpenClaw-style always-on plugin service lifecycle with a typed action surface.
- Hermes sessions are short-lived per turn/chat, while the gateway process is long-lived.

Relevant docs:

- Messaging Gateway: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
- Event Hooks: https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks/
- Plugins: https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins/
- Build a Hermes Plugin: https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin/
- Gateway Internals: https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals/
- Session Storage: https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage/

## Problem Statement

TAP needs an always-on XMTP transport owner to:

- receive inbound TAP messages in real time
- process deferred approvals
- process queued TAP commands from other callers
- maintain reconciliation without cold-starting transport per action

Hermes plugins cannot directly host the TypeScript TAP runtime inside the Python process. Shelling out to one-shot `tap` commands for every action would lose streaming ownership and would reduce Hermes support to polling.

## Proposed Architecture

Hermes support is split into three layers:

### 1. TAP Hermes Daemon

A new long-lived `tap hermes daemon` process runs in Node and owns TAP runtimes for one or more configured identities.

Responsibilities:

- load Hermes TAP identity config
- create one `TapRuntime` per configured TAP identity
- start the runtime and periodic reconcile loop
- classify TAP events into Hermes-facing notifications
- expose a small local control channel for Hermes plugin actions
- exit automatically when the parent Hermes gateway process exits

This daemon is the Hermes equivalent of the OpenClaw background TAP registry.

### 2. Hermes Python Plugin

A bundled Hermes plugin is installed into `~/.hermes/plugins/trusted-agents-tap/`.

Responsibilities:

- register a TAP tool surface inside Hermes
- call the local daemon over a local IPC channel
- inject queued TAP notifications into the next Hermes turn via `pre_llm_call`
- remain thin and avoid implementing TAP protocol behavior itself

### 3. Hermes Gateway Startup Hook

A bundled Hermes gateway hook is installed into `~/.hermes/hooks/trusted-agents-tap/`.

Responsibilities:

- start the TAP Hermes daemon on `gateway:startup`
- pass the current Hermes gateway PID to the daemon
- never block Hermes startup

The hook exists because Hermes has gateway startup hooks, but not an always-on plugin service API.

## Why A Sidecar Daemon

This design is preferred over alternatives:

### Rejected: one-shot `tap message sync` per turn

- loses real-time TAP transport ownership
- degrades to polling
- misses the point of integrating with Hermes’ long-lived gateway model

### Rejected: Python plugin shells into `tap` for every action and every receive path

- still needs some separate owner for XMTP
- duplicates runtime orchestration concerns across Python and TypeScript
- makes deferred approvals and notification handling brittle

### Rejected: port TAP runtime into Python

- violates current architecture
- duplicates core behavior in another language
- creates permanent parity debt

## Runtime Model

### Identity Configuration

Hermes support uses a Hermes-specific TAP config file that mirrors the OpenClaw identity model:

```json
{
  "identities": [
    {
      "name": "default",
      "dataDir": "/abs/path/to/tap-agent",
      "reconcileIntervalMinutes": 10
    }
  ]
}
```

Stored under Hermes home so both the plugin and the daemon can read it.

### Daemon Lifecycle

1. Hermes gateway starts.
2. Hermes startup hook launches `tap hermes daemon --gateway-pid <pid>`.
3. Daemon loads configured identities and starts their `TapRuntime`s.
4. Each runtime owns the XMTP lock for its TAP `dataDir`.
5. Daemon exits when the Hermes gateway PID disappears.

If the daemon dies unexpectedly while Hermes gateway stays up, the Hermes plugin attempts one bounded lazy respawn on the next TAP request or next `pre_llm_call` notification drain. Healthy turns do not pay an extra preflight request.

This keeps TAP tied to Hermes gateway uptime without needing a Hermes shutdown hook.

## IPC Model

The daemon exposes a local IPC server on the current machine.

Requirements:

- local only
- structured request/response
- no network dependency
- usable from Python standard library code

The plugin uses IPC for:

- `status`
- `sync`
- `restart`
- `create_invite`
- `connect`
- `send_message`
- `publish_grants`
- `request_grants`
- `request_funds`
- `transfer`
- `request_meeting`
- `respond_meeting`
- `cancel_meeting`
- `list_pending`
- `resolve_pending`

This preserves a stable tool surface similar to `tap_gateway` in OpenClaw mode.

## Notification Model

The daemon classifies TAP runtime events using the same event buckets already used by the OpenClaw host:

- summary
- escalation
- info
- auto-reply

Notifications are persisted in a Hermes-side queue file so the Python plugin can drain them.

### Hermes-Specific Limitation

OpenClaw can wake the active session immediately through `enqueueSystemEvent()` and `requestHeartbeatNow()`.

Hermes does not provide an equivalent gateway plugin wake-up API. Because of that:

- TAP notifications are injected on the next Hermes turn through a `pre_llm_call` hook
- the daemon still records escalations immediately
- the host cannot force an idle Hermes session to wake up without deeper Hermes changes

This is not a shortcut in implementation; it is a real host limitation that must be respected.

## Approval Behavior

Match the current OpenClaw host semantics:

- connection requests: always defer
- transfer requests:
  - auto-approve when matching grants already cover the request
  - otherwise defer
- scheduling requests: defer
- meeting confirmations: emit summary notification

The daemon owns these hooks because the long-lived runtime receives the TAP events.

## Package / Module Boundaries

### `packages/core`

No Hermes-specific protocol logic.

Only generic improvements are allowed here, for example:

- additional outbox job support where useful across hosts
- exports needed by the Hermes daemon

### `packages/sdk`

Still the TAP runtime entrypoint.

Hermes daemon builds on:

- `createTapRuntime()`
- `TapRuntime`
- runtime/service hooks

### `packages/cli`

Owns Hermes support because:

- Hermes plugin assets must be installed by `tap install`
- Hermes daemon is launched through the `tap` executable
- Hermes config helpers belong with other host setup flows

New CLI-owned Hermes modules:

- Hermes config parsing/writing
- daemon registry
- notification store
- IPC server/client
- install-time asset copy helpers
- Hermes management commands

### Bundled Hermes Assets

Bundled with the CLI package:

- Hermes plugin files
- Hermes startup hook files

These are generated or copied during `tap install --runtime hermes`.

## User-Facing Flow

### Install

```bash
tap install --runtime hermes
```

Installs:

- standard TAP skill for agent runtimes
- Hermes TAP plugin files
- Hermes TAP startup hook files

### Configure Current TAP Identity For Hermes

```bash
tap hermes configure --name default
```

This binds the current TAP `dataDir` into Hermes TAP config.

### Run Hermes Gateway

```bash
hermes gateway
```

On startup, Hermes launches the TAP daemon automatically.

### Use TAP From Hermes

Hermes gets a TAP tool surface for:

- transport-active TAP actions
- pending approval review and resolution
- runtime status

## Reliability Guarantees

- only one TAP daemon instance should own a given Hermes config at a time
- each TAP identity still uses the existing transport owner lock per `dataDir`
- daemon exits when the parent Hermes gateway exits
- notifications survive between turns because they are file-backed
- Hermes plugin attempts one bounded lazy daemon respawn on the next TAP request when the recorded daemon is dead
- Hermes plugin remains functional even if TAP daemon is temporarily unavailable, returning explicit errors instead of hanging

## Testing Strategy

### CLI / Host Tests

- Hermes config parse/write
- daemon registry startup and restart behavior
- notification queue persistence and drain behavior
- IPC request/response behavior
- `tap install --runtime hermes` asset installation
- `tap register` next-step output for Hermes when `hermes` is installed

### Runtime Behavior Tests

- deferred connection notifications
- transfer auto-approval vs escalation
- scheduling escalation flow
- daemon status snapshot generation

### Non-Goals For This Change

- modifying Hermes upstream
- implementing immediate idle-session wakeups that Hermes does not support
- replacing OpenClaw support

## Review Checklist

- Hermes host remains thin; TAP behavior stays in SDK/core.
- Long-lived XMTP ownership exists and is not replaced with polling.
- Hermes integration does not require reimplementing TAP in Python.
- Notification behavior is explicit about the Hermes wake-up limitation.
- Multi-identity support matches the OpenClaw model.
- Install flow is concrete and testable.
