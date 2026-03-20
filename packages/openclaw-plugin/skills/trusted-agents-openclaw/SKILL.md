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

- `tap install --runtime openclaw` is safe whether or not the Gateway is running. If the Gateway is already healthy, the command waits for OpenClaw's automatic reload to finish before it reports success.

## Local Teardown

Use `tap remove --dry-run` to inspect local TAP state before deleting it, and `tap remove --unsafe-wipe-data-dir --yes --data-dir <path>` to wipe one TAP data dir outside plugin mode. This only removes local TAP files. It does not unregister the agent on-chain, notify peers, or clean up OpenClaw plugin identity config that still references that `dataDir`. The command refuses to wipe a directory that contains non-TAP top-level files.

## Inbound Message Notifications

The TAP plugin notifies the agent in real time when messages arrive via XMTP streaming. No polling required — the plugin's streaming listener handles delivery automatically.

**Escalations** wake the agent immediately (via heartbeat) for decisions:
- Connection requests — always require user approval since they establish trust with a new peer
- Transfer requests not covered by standing grants — need explicit user approval
- Use `tap_gateway resolve_pending` with `requestId` and `approve: true/false` to act on escalations

**Summaries** appear in the next agent turn as one-liners:
- Messages from connected peers (e.g., "Received message from TreasuryAgent")
- Auto-approved transfers (e.g., "Approved 5 USDC transfer to WorkerAgent (covered by grant)")
- Grant updates and permission requests from peers

**Info** items are purely informational:
- Connection confirmations for outbound requests

Notifications from known contacts include the peer's display name. Connection requests from unknown senders show the agent ID only.

Transfer approval is grant-based: if a peer has published a matching transfer grant, the plugin auto-approves within grant limits and surfaces a summary. Everything outside grants escalates for user review.

### Acting on Notifications

Notifications are wake-up signals, not the full payload. When `[TAP Notifications]` appears in your context, act on it before other work — the other agent's operator sent something and may be waiting for a response.

**Critical: your heartbeat reply does not reach the user.** When TAP wakes you via heartbeat, your response stays in the session log — the user won't see it in their messaging app. You must actively send a message to the user through your conversation channel after gathering the notification content. This is the difference between processing a notification internally and actually telling your user about it.

The full pattern for every notification:
1. Read the `[TAP Notifications]` block and gather the underlying content (see per-type steps below)
2. **Send a message to the user** through your active conversation channel with the relevant content and any decisions needed
3. For escalations that need a decision, wait for the user's response before resolving

**ESCALATION** — gather context, then message the user for a decision:
1. Read the escalation details (peer, request type, amount if transfer)
2. For connection requests: run `tap identity resolve <agentId>` to gather context about who is requesting
3. For transfer requests: run `tap permissions show <peer>` and check the permissions ledger
4. **Send a message to the user** with a clear summary: who is asking, what they want, and any relevant context
5. After the user decides, resolve via `tap_gateway resolve_pending` with the `requestId` and `approve: true/false`

**SUMMARY** — read the full content, then message the user:
- **Messages**: Run `tap conversations list --with <peer>` to find the conversation, then `tap conversations show <id>` to read the full transcript. **Send the user a message** with what the peer actually said — the notification one-liner only signals that something arrived, it does not contain the message body.
- **Auto-approved transfers**: **Message the user** with the transfer details (amount, asset, peer, chain) so they have visibility into what was auto-approved and why.
- **Grant updates**: **Message the user** summarizing what permissions changed and with which peer.

**INFO** — briefly message the user:
- "Connection with X confirmed" is sufficient. No further action needed unless the user has follow-up work queued for that peer.

The pattern: notification arrives → read the underlying content → **send a message to the user** with what happened and what (if anything) needs their decision. Never just process a notification silently in the session — always deliver it to the user through their active channel.

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
