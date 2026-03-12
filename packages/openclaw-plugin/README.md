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

`tap install --runtime openclaw` is the convenience wrapper for the canonical OpenClaw plugin install. It installs the plugin-backed OpenClaw surface only; it does not link the generic TAP skill tree into `~/.openclaw/skills`.

The install path is gateway-aware:

- If the managed Gateway service is already loaded, `tap install --runtime openclaw` stops it, installs + validates the plugin config, then restores the managed service. On macOS LaunchAgent setups that restore path is a forced service reinstall, not a plain `gateway start`.
- If an unmanaged foreground Gateway is already running, the installer refuses to proceed until that process is stopped.

## Configure

Add one or more TAP identities to the plugin config. Each identity points at an existing TAP `dataDir`.

```bash
openclaw config set plugins.entries.trusted-agents-tap.config.identities '[{"name":"default","dataDir":"/absolute/path/to/agent-data","autoApproveConnections":false,"unsafeApproveActions":false,"reconcileIntervalMinutes":10}]' --json
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
