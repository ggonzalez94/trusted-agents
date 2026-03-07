---
name: trusted-agents-openclaw
description: Operate Trusted Agents Protocol inside OpenClaw when the TAP plugin is installed. Use this skill whenever OpenClaw has the `tap_gateway` tool available, or when the user wants to install TAP from this repo into OpenClaw Gateway, configure TAP identities, check runtime status, reconcile TAP messages, or recover a stopped TAP background runtime.
---

# Trusted Agents OpenClaw

Use this skill when working inside OpenClaw and TAP may be installed as a Gateway plugin.

## Decision Rule

1. Use plugin mode only when `tap_gateway` is available, `tap_gateway` action `status` reports at least one configured identity, and `status.warnings` is empty.
2. In plugin mode, use `tap_gateway` for TAP status, sync, connect, messaging, grant updates, fund requests, and pending request resolution.
3. If the plugin is not installed or not configured yet, fall back to the normal `tap` CLI workflow and run `tap message sync` on heartbeat.
4. Do not run `tap message listen` in OpenClaw shell background jobs as the primary runtime.

## Install From This Repo

```bash
bun install
bun run build
cd packages/cli && npm link
cd ../..
openclaw plugins install --link ./packages/openclaw-plugin
```

## Runtime Tasks

- Check runtime health: `tap_gateway` with `action: "status"`
- Treat any non-empty `warnings` in the `status` result as setup or runtime problems to fix before relying on plugin mode.
- Force reconciliation: `tap_gateway` with `action: "sync"`
- Restart a stopped runtime: `tap_gateway` with `action: "restart"`
- Review queued approvals: `tap_gateway` with `action: "list_pending"`
- Resolve queued approvals: `tap_gateway` with `action: "resolve_pending"`
- Read-only inspection through `tap` remains safe: `tap contacts list`
- Read-only inspection through `tap` remains safe: `tap permissions show <peer>`
- Read-only inspection through `tap` remains safe: `tap conversations list --with <peer>`

## References

- `references/install.md`
- `references/runtime-modes.md`
