# OpenClaw Plugin And Deployment Plan

Date: 2026-03-07

## Goal

Document the implemented TAP deployment model:

1. OpenClaw-native TAP via a Gateway plugin with a background TAP runtime
2. a portable non-OpenClaw deployment story that still works for other agent hosts
3. the transport-ownership rules that keep TAP reliable

## Implemented Architecture

### Shared runtime

The durable TAP runtime now lives in `packages/core`:

- `packages/core/src/runtime/service.ts`
- `packages/core/src/runtime/request-journal.ts`
- `packages/core/src/runtime/transport-owner-lock.ts`
- `packages/core/src/runtime/default-context.ts`

Key behavior:

- async TAP protocol with separate transport receipts and later business outcomes
- one `TapMessagingService` per identity
- startup reconcile and explicit `syncOnce()`
- durable request journal for async action dedupe and replay recovery
- minimal outbound `pending-connects.json` state for connection result correlation
- one transport owner per `dataDir` enforced with `.transport.lock`

### Host adapters

- `packages/cli`
  - thin CLI adapter over `TapMessagingService`
  - `tap message sync` is the portable correctness baseline
  - `tap message listen` remains available for one dedicated long-lived owner process
- `packages/openclaw-plugin`
  - OpenClaw Gateway plugin
  - owns TAP as a background service inside Gateway
  - exposes one tool, `tap_gateway`, for transport-active TAP operations

## OpenClaw Recommendation

If OpenClaw is the main target and we want streaming to be the default there, the right architecture is the plugin.

Why:

- Gateway is already the supervised long-lived host process.
- OpenClaw plugins can register background services and skills.
- OpenClaw shell background jobs are not a reliable 24/7 transport owner.
- TAP now enforces one transport owner per identity, so Gateway should be that owner in plugin mode.

## Plugin Package

Path:

```text
packages/openclaw-plugin/
├── package.json
├── openclaw.plugin.json
├── index.ts
├── src/
│   ├── config.ts
│   ├── plugin.ts
│   ├── registry.ts
│   └── tool.ts
└── skills/
    └── trusted-agents-openclaw/
```

### Background service model

One runtime per configured identity:

- load TAP config from the identity `dataDir`
- build the normal TAP context from that `dataDir`
- start XMTP streaming
- run reconcile at startup
- keep periodic reconcile running on a timer
- queue inbound approval-required work in the TAP request journal unless auto-approve is enabled

### Plugin config

The plugin reads one or more TAP identities:

```json
{
  "identities": [
    {
      "name": "default",
      "dataDir": "/absolute/path/to/tap-agent",
      "unsafeApproveActions": false,
      "reconcileIntervalMinutes": 10
    }
  ]
}
```

### Agent-facing tool surface

The plugin exposes `tap_gateway` with these actions:

- `status`
- `sync`
- `restart`
- `create_invite`
- `connect`
- `send_message`
- `publish_grants`
- `request_grants`
- `request_funds`
- `list_pending`
- `resolve_pending`

This is the answer to the transport-owner problem in OpenClaw:

- Gateway owns the TAP runtime
- the agent uses `tap_gateway` for transport-active operations
- the same identity does not need to spawn separate `tap` processes to send or resolve TAP work

## Install Flow From This Repo

This is the intended agent-driven install path:

```bash
bun install
bun run build
cd packages/cli && npm link
cd ../..
tap install --runtime openclaw
```

Then:

1. run `tap init`
2. run `tap register`
3. configure the plugin identity to point at that TAP `dataDir`:

```bash
openclaw config set plugins.entries.trusted-agents-tap.config.identities '[{"name":"default","dataDir":"/absolute/path/to/tap-data","reconcileIntervalMinutes":10}]' --json
```

4. restart the Gateway
5. verify with `tap_gateway` action `status`

Low-level fallback:

```bash
openclaw plugins install --link ./packages/openclaw-plugin
```

That raw OpenClaw command only links the plugin. It does not run TAP's Gateway stop/restore logic and it does not clean up legacy `~/.openclaw/skills/trusted-agents` entries.

## Non-OpenClaw Deployment Modes

### 1. Embedded runtime mode

For other serious agent hosts, the recommended mode is still one long-lived TAP owner process per identity using the shared `TapMessagingService`.

Recommended defaults:

- streaming enabled
- startup reconcile
- periodic reconcile
- one transport owner per identity

### 2. CLI mode

For plain CLI and short-lived automation:

- use `tap message sync` as the default
- use `tap message listen` only when one process truly owns that identity
- keep periodic reconcile even when streaming is enabled

## Transport Ownership Rule

TAP now enforces one transport owner per identity `dataDir`.

Implications:

- OpenClaw plugin mode: `tap_gateway` is the preferred surface
- CLI mode: stop any existing listener before running another transport-active CLI command for the same identity
- scheduler mode: prefer `tap message sync`

Known limitation:

- generic CLI background-listener mode still does not provide an IPC/control plane for other CLI invocations
- that is why `tap message sync` remains the portable default outside plugin or embedded-runtime mode

## Skills

The skills are split by deployment mode:

- repo TAP skills in `packages/sdk/skills/trusted-agents/`
  - teach runtime-mode selection
  - teach repo install flow for OpenClaw
  - keep CLI command docs concise
- plugin skills in `packages/openclaw-plugin/skills/trusted-agents-openclaw/`
  - teach `tap_gateway`
  - teach plugin install/configuration
  - teach recovery actions such as `status`, `sync`, `restart`, and pending resolution

## Summary

The implemented recommendation is:

- OpenClaw main target: use the plugin and make Gateway the TAP owner
- other always-on hosts: embed the shared TAP runtime directly
- generic CLI and schedulers: use `tap message sync` by default
- keep `tap message listen` as a supported low-latency mode, but only when one process clearly owns that identity
