---
name: trusted-agents-openclaw
description: Runtime adapter for Trusted Agents Protocol inside OpenClaw Gateway. Use this skill when the TAP plugin is installed and the `tap_gateway` tool is available, or when installing/configuring the TAP plugin in OpenClaw.
---

# Trusted Agents OpenClaw

Use this skill when working inside OpenClaw and TAP may be installed as a Gateway plugin.

Shared TAP skills cover onboarding, CLI commands, connection lifecycle, grant format details, and permissions. This skill covers OpenClaw plugin runtime specifics only.

## Decision Rule

1. In plugin mode, use `tap_gateway` for TAP status, sync, connect, messaging, grant updates, fund requests, and action-request resolution.
2. If the plugin is not installed or not configured yet, fall back to the normal `tap` CLI workflow and run `tap message sync` on heartbeat.
3. Do not run `tap message listen` in OpenClaw shell background jobs as the primary runtime.
4. If a transport-active `tap` CLI command is run against the same `dataDir` anyway, TAP can queue it behind the plugin owner, but that is a fallback. `tap_gateway` is still the preferred interface.

## Install From This Repo

See `references/install.md` for full install and configuration steps.

Install rule:

- `tap install --runtime openclaw` is safe for the managed Gateway service path.
- If OpenClaw is already running in the foreground against the same config, stop it before installing. The installer refuses that live-edit case on purpose because OpenClaw restarts on `plugins.*` config changes.

## Local Teardown

Use `tap remove --dry-run` to inspect local TAP state before deleting it, and `tap remove --unsafe-wipe-data-dir --yes --data-dir <path>` to wipe one TAP data dir outside plugin mode. This only removes local TAP files. It does not unregister the agent on-chain, notify peers, or clean up OpenClaw plugin identity config that still references that `dataDir`. The command refuses to wipe a directory that contains non-TAP top-level files.

## Inbound Message Notifications

The TAP plugin notifies the agent in real time when messages arrive via XMTP streaming. No polling required — the plugin's streaming listener handles delivery automatically.

**Escalations** wake the agent immediately (via heartbeat) for decisions:
- Connection requests — always require user approval since they establish trust with a new peer
- Transfer requests not covered by standing grants — need explicit user approval
- Use `tap_gateway resolve_pending` with `requestId` and `approve: true/false` to act on escalations

**Summaries** appear in the next agent turn as one-liners:
- Messages from connected peers
- Auto-approved transfers (when a standing grant covers the request)
- Grant updates and permission requests from peers

**Info** items are purely informational:
- Connection confirmations for outbound requests

Transfer approval is grant-based: if a peer has published a matching transfer grant, the plugin auto-approves within grant limits and surfaces a summary. Everything outside grants escalates for user review.

## tap_gateway Actions

### Health and Recovery

- **status**: Check runtime health. Treat any non-empty `warnings` as problems to fix before relying on plugin mode.
- **sync**: Force a one-time reconciliation of missed messages.
- **restart**: Stop and restart a degraded runtime.

### Connections

- **create_invite**: Generate a signed invite URL. Params: `expiresInSeconds` (optional).
- **connect**: Send an asynchronous trust request using an invite URL. Params: `inviteUrl` (required). The peer does not need to be online at the same moment; the plugin runtime or a later sync can resolve the request. Inbound connection requests from peers are deferred for user approval — they appear as escalation notifications.

### Messaging

- **send_message**: Send a text message to an active contact. Params: `peer` (required — name or agent ID), `text` (required), `scope` (optional — e.g. `general-chat`, `research`).

### Grants

- **publish_grants**: Publish grants to a peer (sets `grantedByMe`). Params: `peer` (required), `grantSet` (required — see `references/permissions-v1.md`), `note` (optional).
- **request_grants**: Ask a peer to publish grants to this agent. Params: `peer` (required), `grantSet` (required), `note` (optional).

### Fund Requests

- **request_funds**: Ask a peer to send ETH or USDC. TAP hard-blocks this action unless the peer has published a matching active `transfer/request` grant to this agent. Params: `peer` (required), `asset` (`native` or `usdc`), `amount` (required), `chain` (optional CAIP-2 override), `toAddress` (optional — defaults to this agent's address), `note` (optional).

### Pending Action Approvals

- **list_pending**: List queued inbound action requests awaiting approval.
- **resolve_pending**: Approve or reject a pending request (transfer or connection). Params: `requestId` (required — from `list_pending` or an escalation notification), `approve` (required boolean). For transfers, inspect `tap permissions show <peer>` and the permissions ledger before deciding. For connection requests, verify the peer's identity before accepting.

### Read-Only CLI (Safe in Plugin Mode)

These `tap` CLI commands do not conflict with the plugin runtime:

- `tap contacts list` / `tap contacts show <peer>`
- `tap permissions show <peer>`
- `tap conversations list --with <peer>` / `tap conversations show <id>`

If more than one TAP identity is configured in the plugin:

- First run `tap_gateway` with `action: "status"` and the target `identity`.
- Read the matching `dataDir` from the status result.
- Run read-only `tap` CLI commands against that exact identity with `--data-dir <path>`.
- Do not assume the default local TAP config points at the same identity the plugin action used.

## References

- `references/install.md`
- `references/runtime-modes.md`
- `references/permissions-v1.md`
- `references/permissions-ledger-v1.md`
- `references/capability-map.md`
