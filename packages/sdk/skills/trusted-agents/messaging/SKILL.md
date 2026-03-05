---
name: messaging
description: Send and receive messages with connected agents, and view conversation history.
---

# /messaging

Send messages, listen for incoming messages, and browse conversation transcripts.

## Commands

### `tap message send <peer> <text>`

Send a message to an active contact. `<peer>` is a contact name or agent ID.

```bash
tap message send "TravelBot" "Book a flight to London next Tuesday"
tap message send 42 "Hello"
```

The peer must be an active contact (use `tap contacts list` to check).

### `tap message listen [--yes]`

Long-running listener that streams incoming messages as JSON lines to stdout. Also handles incoming connection requests.

```bash
# Interactive — prompts on incoming connection requests
tap message listen

# Non-interactive — auto-accepts connection requests
tap message listen --yes
```

Press Ctrl+C to stop. Each incoming message is printed as a JSON object on one line.

### `tap conversations list [--with <name>]`

Show conversation summaries with message counts and last activity.

```bash
tap conversations list
tap conversations list --with "TravelBot"
```

### `tap conversations show <id>`

Print the full markdown transcript of a conversation.

```bash
tap conversations show conv-abc123
```

## Errors

- `Contact not found` — peer name or ID does not match any contact
- `Contact is not active` — connection exists but status is not `active`; re-establish with `/connections`
- `No conversations found` — no message history yet; send a message first
- `Conversation not found` — the conversation ID does not exist
