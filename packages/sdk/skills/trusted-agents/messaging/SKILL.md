---
name: messaging
description: Send TAP messages, reconcile missed XMTP traffic, run the listener only when one process owns the identity, review conversations, and handle transfer requests with runtime judgment. Use this skill whenever the user mentions TAP messaging, XMTP listening, heartbeat reconciliation, or transport owner conflicts.
---

# /messaging

Use this skill for agent-to-agent communication after a connection is active and for converging asynchronous connection/results traffic.

## When To Use Sync vs Listen

- **`tap message sync`** — default for AI agents. One-shot reconciliation, safe for episodic or scheduled runtimes. Use this when other processes may also need the identity, or in scheduler-driven setups.
- **`tap message listen`** — long-lived XMTP stream. Use only when one dedicated daemon can exclusively own the identity for the entire session. Do not use in short-lived scripts or alongside other transport-active processes.

## Runtime Judgment

- TAP hard-blocks transfer execution unless a matching active transfer grant exists.
- Keep only one transport-active CLI process per identity.
- Most transport-active CLI commands now queue behind an already-running TAP owner for the same `dataDir` instead of failing immediately.
- Before approving a high-impact request, inspect:
  - `tap permissions show <peer>`
  - `<dataDir>/notes/permissions-ledger.md`
- `--unsafe-approve-actions` skips interactive review **and** bypasses transfer grant enforcement. Use it only for controlled testing — never in production.

## Transfer Request Lifecycle

Prerequisites:
- An **active** connection with the peer
- The peer has published a `transfer/request` grant to this agent (visible in `grantedByPeer`)

Flow:
1. Send: `tap message request-funds <peer> --asset usdc --amount 5`
2. TAP checks for a matching active transfer grant from the peer — hard-blocks if none exists
3. The peer receives the request via sync or listener and decides to approve or reject
4. The `action/result` arrives on this agent's next sync or via the listener

## Commands

### `tap message send <peer> <text> [--scope <scope>]`

Send a message to an active contact. `--scope` is a semantic label for the conversation. If another TAP runtime already owns this identity, the command queues behind that owner and may still complete during the command wait window.

```bash
tap message send WorkerAgent "Status update?" --scope general-chat
```

### `tap message request-funds <peer> --asset <native|usdc> --amount <amount> [--chain <chain>] [--to <address>] [--note <text>]`

Ask a peer to send ETH or USDC. The immediate send only returns a transport receipt; the business outcome arrives later as `action/result`. If another TAP runtime already owns this identity, the request queues behind that owner.

```bash
tap message request-funds TreasuryAgent --asset usdc --amount 5 --chain base --note "weekly research budget"
```

If the peer rejects or fails the request and that `action/result` arrives during the command wait window, the command exits non-zero.

### `tap message sync [--unsafe-approve-actions]`

Reconcile missed XMTP messages once. Use this in OpenClaw heartbeat-style turns or other scheduled runtimes. This is also the normal way to converge asynchronous `connection/request` and `connection/result` traffic when agents are not simultaneously online.

```bash
tap message sync
tap message sync --unsafe-approve-actions
```

### `tap message listen [--unsafe-approve-actions]`

Run the long-lived XMTP stream listener. It processes connection requests/results, grant updates, messages, and action requests/results.

```bash
tap message listen
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
- `TransportOwnershipError` — another TAP runtime already owns this identity and this command could not be queued behind it; use the plugin tool, stop the other owner, or use `tap message sync` instead of a second streaming process.
