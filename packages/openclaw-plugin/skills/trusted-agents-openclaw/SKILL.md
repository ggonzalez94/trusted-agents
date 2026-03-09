---
name: trusted-agents-openclaw
description: Operate Trusted Agents Protocol inside OpenClaw when the TAP plugin is installed. Use this skill whenever OpenClaw has the `tap_gateway` tool available, or when the user wants to install TAP from this repo into OpenClaw Gateway, configure TAP identities, check runtime status, reconcile TAP messages, or recover a stopped TAP background runtime.
---

# Trusted Agents OpenClaw

Use this skill when working inside OpenClaw and TAP may be installed as a Gateway plugin.

## Mental Model

- Capabilities are public discovery labels in the on-chain registration file. They are hints, not permissions.
- Connections establish trust only. They do not grant business permissions.
- Permissions are directional grant sets per contact:
  - `grantedByMe`: what the peer may ask this agent to do
  - `grantedByPeer`: what this agent may ask the peer to do
- Before approving high-impact actions, check grants via `tap permissions show <peer>` and the permissions ledger at `<dataDir>/notes/permissions-ledger.md`.
- Grant format details: `references/permissions-v1.md`
- Ledger format details: `references/permissions-ledger-v1.md`
- Capability-to-scope mapping: `references/capability-map.md`

## Chain Selection

Use mainnet chains only: `base` (default) or `taiko`. Do not suggest testnets to users unless they explicitely ask for it.

## Decision Rule

1. In plugin mode, use `tap_gateway` for TAP status, sync, connect, messaging, grant updates, fund requests, and pending request resolution.
2. If the plugin is not installed or not configured yet, fall back to the normal `tap` CLI workflow and run `tap message sync` on heartbeat.
3. Do not run `tap message listen` in OpenClaw shell background jobs as the primary runtime.

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

## Local Teardown

Use `tap remove --dry-run` to inspect local TAP state before deleting it, and `tap remove --unsafe-wipe-data-dir --yes --data-dir <path>` to wipe one TAP data dir outside plugin mode. This only removes local TAP files. It does not unregister the agent on-chain, notify peers, or clean up OpenClaw plugin identity config that still references that `dataDir`. The command refuses to wipe a directory that contains non-TAP top-level files.

## tap_gateway Actions

### Health and Recovery

- **status**: Check runtime health. Treat any non-empty `warnings` as problems to fix before relying on plugin mode.
- **sync**: Force a one-time reconciliation of missed messages.
- **restart**: Stop and restart a degraded runtime.

### Connections

- **create_invite**: Generate a signed invite URL. Params: `expiresInSeconds` (optional).
- **connect**: Send a connection request using an invite URL. Params: `inviteUrl` (required), `requestedGrantSet` (optional), `offeredGrantSet` (optional). If offered grants are included and the peer accepts, those grants become `grantedByPeer` on the peer's side immediately.

### Messaging

- **send_message**: Send a text message to an active contact. Params: `peer` (required — name or agent ID), `text` (required), `scope` (optional — e.g. `general-chat`, `research`).

### Grants

- **publish_grants**: Publish grants to a peer (sets `grantedByMe`). Params: `peer` (required), `grantSet` (required — see `references/permissions-v1.md`), `note` (optional).
- **request_grants**: Ask a peer to publish grants to this agent. Params: `peer` (required), `grantSet` (required), `note` (optional).

### Fund Requests

- **request_funds**: Ask a peer to send ETH or USDC. Params: `peer` (required), `asset` (`native` or `usdc`), `amount` (required), `chain` (optional CAIP-2 override), `toAddress` (optional — defaults to this agent's address), `note` (optional).

### Pending Approvals

- **list_pending**: List queued inbound requests awaiting approval.
- **resolve_pending**: Approve or reject a pending request. Params: `requestId` (required — from `list_pending`), `approve` (required boolean). Before deciding, inspect `tap permissions show <peer>` and the permissions ledger.

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
