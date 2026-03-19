# Trusted Agents OpenClaw Plugin

Run TAP inside OpenClaw Gateway as a supervised background service.

## Install From This Repo

Recommended:

```bash
bash scripts/install.sh
```

Manual equivalent:

```bash
bun install
bun run build
cd packages/cli && npm link
tap install --runtime openclaw
```

`tap install --runtime openclaw` is the recommended managed install path. It installs the plugin-backed OpenClaw surface only; it does not link the generic TAP skill tree into `~/.openclaw/skills`.

The installer does not force a stop/start cycle. If the Gateway is already running and healthy, `tap install --runtime openclaw` waits for OpenClaw's built-in config reload to restart the Gateway onto the refreshed plugin before returning. If the Gateway is not running, the installer updates the plugin link and config only.

- If a TAP-managed legacy `~/.openclaw/skills/trusted-agents` symlink exists, the installer removes it so Gateway only sees the plugin-bundled TAP skill tree.

Low-level manual link:

```bash
openclaw plugins install --link ./packages/openclaw-plugin
```

That raw OpenClaw command only links the plugin. It does not clean up legacy `~/.openclaw/skills/trusted-agents` entries or wait for a running Gateway to reload onto the refreshed plugin.

## Configure

Add one or more TAP identities to the plugin config. Each identity points at an existing TAP `dataDir`.

```bash
openclaw config set plugins.entries.trusted-agents-tap.config.identities '[{"name":"default","dataDir":"/absolute/path/to/agent-data","reconcileIntervalMinutes":10}]' --json
```

Restart the Gateway after plugin config changes. If the Gateway warns that no TAP identities are configured immediately after install, that is expected until this step is done.

## Runtime Model

- Gateway owns the long-lived TAP transport.
- `tap_gateway` is the preferred surface for TAP connect/send/request operations in plugin mode.
- Use `tap_gateway` action `status` to confirm at least one identity is configured before treating plugin mode as active.
- If `status.warnings` is non-empty, resolve those warnings before relying on plugin mode.
- If more than one identity is configured, pass `identity` in each `tap_gateway` tool call.
- Periodic reconcile still runs even when streaming is healthy.
- Read-only `tap` CLI commands remain safe for contacts, permissions inspection, and conversation history.
- `tap message sync` remains the fallback when the plugin is not installed.
