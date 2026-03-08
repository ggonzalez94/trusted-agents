---
name: messaging
description: Send TAP messages, reconcile missed XMTP traffic, run the listener only when one process owns the identity, review conversations, and handle transfer requests with runtime judgment. Use this skill whenever the user mentions TAP messaging, XMTP listening, heartbeat reconciliation, OpenClaw TAP plugin mode, or transport owner conflicts.
---

# /messaging

Use this skill for agent-to-agent communication after a connection is active.

## Runtime Judgment

- TAP hard-blocks transfer execution unless a matching active transfer grant exists.
- If the OpenClaw TAP plugin is installed, prefer the `tap_gateway` tool over transport-active CLI commands.
- Keep only one transport-active CLI process per identity.
- Prefer `tap message sync` for scheduler-driven agents, OpenClaw heartbeats, or any setup where the same identity also runs short-lived TAP commands.
- Use `tap message listen` only when one dedicated long-lived TAP process can own the identity.
- Before approving a high-impact request, inspect:
  - `tap permissions show <peer>`
  - `<dataDir>/notes/permissions-ledger.md`
- `--unsafe-approve-actions` skips interactive review and bypasses transfer grant enforcement. Use it only for controlled testing.

## Commands

### `tap message send <peer> <text> [--scope <scope>]`

Send a message to an active contact. `--scope` is a semantic label for the conversation.

```bash
tap message send WorkerAgent "Status update?" --scope general-chat
```

### `tap message request-funds <peer> --asset <native|usdc> --amount <amount> [--chain <chain>] [--to <address>] [--note <text>]`

Ask a peer to send ETH or USDC. The immediate send only returns a transport receipt; the business outcome arrives later as `action/result`.

```bash
tap message request-funds TreasuryAgent --asset usdc --amount 5 --chain base --note "weekly research budget"
```

If the peer rejects or fails the request and that `action/result` arrives during the command wait window, the command exits non-zero.

### `tap message sync [--yes] [--unsafe-approve-actions]`

Reconcile missed XMTP messages once. Use this in OpenClaw heartbeat-style turns or other scheduled runtimes.

```bash
tap message sync
tap message sync --yes --unsafe-approve-actions
```

### `tap message listen [--yes] [--unsafe-approve-actions]`

Run the long-lived XMTP stream listener. It processes connection requests/results, grant updates, messages, and action requests/results.

```bash
tap message listen --yes
```

### `tap conversations list [--with <name>]`

List stored conversation summaries.

```bash
tap conversations list --with TreasuryAgent
```

### `tap conversations show <id>`

Show the full markdown transcript for one conversation.

```bash
tap conversations show conv-abc123
```

## Common Errors

- `Peer not found in contacts` — no active contact matches the name or agent ID.
- `Contact is not active` — re-establish the connection.
- `Action rejected by agent` — there is no matching active transfer grant, or the agent rejected the request.
- `Conversation not found` — the transcript ID does not exist yet.
- `TransportOwnershipError` — another TAP runtime already owns this identity; use the plugin tool, stop the other owner, or use `tap message sync` instead of a second streaming process.
