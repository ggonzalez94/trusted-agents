---
name: connections
description: Create invites, send async TAP connection requests, and manage directional grants for each peer. Use this skill whenever the user wants to connect agents, inspect pending or active contacts, or exchange permission intent and grant files.
---

# /connections

Use this skill for invites, connections, and permission grants.

## Rules

- `tap connect` establishes trust only.
- Initial permission intent can be shown during connect with grant files.
- If a connect request includes offered grants and the peer accepts, those grants become `grantedByPeer` for the accepting side immediately.
- Published grants are directional:
  - `grantedByMe`: what the peer may ask this agent to do
  - `grantedByPeer`: what this agent may ask the peer to do
- Grant file format: `references/permissions-v1.md`

## Commands

### `tap invite create [--expiry <seconds>]`

Generate a signed invite URL.

```bash
tap invite create --expiry 3600
```

### `tap invite list`

List unused local invites.

```bash
tap invite list
```

### `tap connect <invite-url> [--yes] [--request-grants-file <path>] [--grant-file <path>]`

Send an asynchronous connection request. The remote peer only needs `tap message listen` or `tap message sync` to receive it; acceptance arrives later as `connection/result`.

```bash
tap connect "<invite-url>" --yes --request-grants-file ./grants/request.json --grant-file ./grants/offer.json
```

During connect, TAP surfaces:
- what this agent wants to request after connect
- what this agent plans to offer after connect
- a local pending contact until the peer resolves the request

### `tap permissions show [peer]`

Show grants for one peer or grant counts for all peers.

```bash
tap permissions show TreasuryAgent
```

### `tap permissions grant <peer> --file <path> [--note <text>]`

Publish the grants this agent gives to a peer.

```bash
tap permissions grant WorkerAgent --file ./grants/worker-allowances.json --note "weekly payment policy"
```

### `tap permissions request <peer> --file <path> [--note <text>]`

Ask a peer to publish the listed grants to this agent.

```bash
tap permissions request TreasuryAgent --file ./grants/request-usdc.json --note "need weekly budget"
```

### `tap permissions revoke <peer> --grant-id <id> [--note <text>]`

Revoke one previously published grant.

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
- `Peer not found in contacts` — connect first or check the contact name/agent ID.
- `Grant not found` — the revoke target does not exist in `grantedByMe`.
- `TransportOwnershipError` — another TAP runtime owns the same identity. In OpenClaw plugin mode, use the plugin tool instead of a transport-active CLI command.
