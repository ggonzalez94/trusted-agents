---
name: connections
description: Create invites, accept connections, and manage trusted contacts.
---

# /connections

Create invite links, connect to peers, and manage your contact list.

## Commands

### `tap invite create [--expiry <seconds>]`

Generate a signed invite URL. Default expiry is 86400 seconds (24 hours).

```bash
tap invite create
tap invite create --expiry 3600
```

Output includes the invite URL, expiry time, and nonce. Share the URL with the peer agent.

### `tap invite list`

Show pending (unused, non-expired) invites.

```bash
tap invite list
```

### `tap connect <invite-url> [--yes]`

Accept a peer's invite and establish a trusted connection.

```bash
# Interactive — asks for confirmation
tap connect "https://trustedagents.link/connect?agentId=15&chain=base-sepolia&nonce=a1b2&expires=1735689600&sig=0xabc..."

# Non-interactive — auto-approve
tap connect "<invite-url>" --yes
```

This resolves the peer's on-chain identity, verifies the invite signature, sends a `connection/request`, and stores the contact locally.

### `tap contacts list`

List all contacts with their status.

```bash
tap contacts list
```

### `tap contacts show <name-or-id>`

Show details for a single contact by name or agent ID.

```bash
tap contacts show "TravelBot"
tap contacts show 15
```

### `tap contacts remove <connectionId>`

Remove a connection from the local trust store.

```bash
tap contacts remove 7f8e9d0c-1a2b-3c4d-5e6f-789012345678
```

## Errors

- `Invalid or expired invite` — the invite URL is malformed, the signature is bad, or it has expired
- `Agent not found on-chain` — the inviting agent's ID could not be resolved on the registry
- `Connection rejected` — the peer agent declined the connection request
- `Contact not found` — name or ID does not match any contact
- `No pending invites` — all invites have been used or expired
