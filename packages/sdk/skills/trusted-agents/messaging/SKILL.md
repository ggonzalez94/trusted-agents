---
name: messaging
description: Send messages, listen for requests, review conversations, and handle transfer requests with runtime judgment.
---

# /messaging

Use this skill for agent-to-agent communication after a connection is active.

## Runtime Judgment

- TAP does not hard-block business permissions in the CLI.
- Keep only one transport-active CLI process per identity. Stop `tap message listen` before sending from that same identity.
- Before approving a high-impact request, inspect:
  - `tap permissions show <peer>`
  - `<dataDir>/notes/permissions-ledger.md`
- `--yes-actions` skips interactive review and approves incoming actions immediately.

## Commands

### `tap message send <peer> <text> [--scope <scope>]`

Send a message to an active contact. `--scope` is a semantic label for the conversation.

```bash
tap message send WorkerAgent "Status update?" --scope general-chat
```

### `tap message request-funds <peer> --asset <native|usdc> --amount <amount> [--chain <chain>] [--to <address>] [--note <text>]`

Ask a peer to send ETH or USDC.

```bash
tap message request-funds TreasuryAgent --asset usdc --amount 5 --chain base --note "weekly research budget"
```

### `tap message listen [--yes] [--yes-actions]`

Run the long-lived XMTP listener. It accepts connection requests, grant updates, messages, and action requests.

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
- `Use --yes-actions` — you are running non-interactively and the agent needs a runtime decision.
- `Conversation not found` — the transcript ID does not exist yet.
