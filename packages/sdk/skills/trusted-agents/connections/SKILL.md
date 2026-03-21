---
name: connections
description: Create invites, connect agents, and manage directional grants for each peer. Use this skill whenever the user wants to connect agents, inspect active contacts, or exchange permission sets.
---

# /connections

Use this skill for invites, connections, and permission grants.

## Connection Flow

Two-agent connection dance:
1. Agent A creates an invite: `tap invite create`
2. Agent B connects using the invite: `tap connect "<invite-url>" --yes`
3. Agent A receives the request via `tap message listen` or `tap message sync` and auto-accepts if the invite is valid
4. Agent A creates an **active** contact immediately and sends `connection/result`
5. Agent B receives the result during the same command or later via `tap message sync`
6. Agent B creates an **active** contact when that result arrives

Key: invites are the implicit connection approval. There is no manual connection approval step and no `tap invite list`. `--yes` only skips the initiator's local confirmation prompt.

## Rules

- `tap connect` establishes trust only.
- Published grants are directional:
  - `grantedByMe`: what the peer may ask this agent to do
  - `grantedByPeer`: what this agent may ask the peer to do
- Grant file format: `references/permissions-v1.md`
- Permission grants are exchanged after connect with `tap permissions grant` and `tap permissions request`.

## Commands

### `tap invite create [--expiry <seconds>]`

Generate a signed invite URL.

Invites are reusable bearer credentials until they expire. Sharing the invite is the approval mechanism.

```bash
tap invite create --expiry 3600
```

### `tap connect <invite-url> [--yes] [--wait [seconds]]`

Send an asynchronous trust request using a signed invite. The peer does not need to be online at the same moment. TAP sends `connection/request` immediately and creates the contact on this side only after a matching `connection/result` arrives. The remote peer auto-accepts valid invites during `tap message listen` or `tap message sync`. If another TAP runtime already owns this identity, `tap connect` queues behind that owner instead of failing.

The `--wait` flag polls for the connection to become active (default: 60s timeout). Without `--wait`, returns immediately with `pending` status.

```bash
tap connect "<invite-url>" --yes --wait 60
```

### `tap permissions show [peer]`

Show grants for one peer or grant counts for all peers.

```bash
tap permissions show TreasuryAgent
```

### `tap permissions grant <peer> --file <path> [--note <text>]`

Publish the grants this agent gives to a peer. If a listener or plugin already owns the same `dataDir`, the command queues behind that owner and the live runtime publishes the update.

```bash
tap permissions grant WorkerAgent --file ./grants/worker-allowances.json --note "weekly payment policy"
```

### `tap permissions request <peer> --file <path> [--note <text>]`

Ask a peer to publish the listed grants to this agent. If another runtime already owns this identity, the request queues behind that owner.

```bash
tap permissions request TreasuryAgent --file ./grants/request-usdc.json --note "need weekly budget"
```

### `tap permissions revoke <peer> --grant-id <id> [--note <text>]`

Revoke one previously published grant. If a live TAP owner already exists for this identity, the revoke queues behind that owner.

```bash
tap permissions revoke WorkerAgent --grant-id worker-weekly-usdc --note "budget paused"
```

### `tap contacts list`

List contacts and grant counts.

```bash
tap contacts list
```

### `tap contacts show <name-or-id>`

Show one contact, including `granted_by_me` and `granted_by_peer`.

```bash
tap contacts show WorkerAgent
```

### `tap contacts remove <connectionId>`

Remove one contact from the local trust store.

```bash
tap contacts remove 7f8e9d0c-1a2b-3c4d-5e6f-789012345678
```

## Common Errors

- `Invalid or expired invite` — the invite URL is malformed, expired, or has a bad signature.
- `Connection rejected` — the peer declined the trust request when the result arrived.
- `Contact not active yet` — the peer has not synced the request or this agent has not yet ingested the result. Run `tap message sync`.
- `Peer not found in contacts` — connect first or check the contact name/agent ID.
- `Grant not found` — the revoke target does not exist in `grantedByMe`.
- `TransportOwnershipError` — another TAP runtime owns the same identity and this command could not be queued behind it. In OpenClaw plugin mode, `tap_gateway` is still the preferred path.
