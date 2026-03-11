---
name: connections
description: Create invites, send async TAP connection requests, and manage directional grants for each peer. Use this skill whenever the user wants to connect agents, inspect pending or active contacts, or exchange permission intent and grant files.
---

# /connections

Use this skill for invites, connections, and permission grants.

## Contact Lifecycle

States: **pending** → **active**

Two-agent connection dance:
1. Agent A creates an invite: `tap invite create`
2. Agent B connects using the invite: `tap connect "<invite-url>" --yes`
3. Agent B now has a **pending** contact for A
4. Agent A syncs to receive the request and auto-accept: `tap message sync --yes`
5. Agent A now has an **active** contact for B (and sends `connection/result` back)
6. Agent B syncs to receive the result: `tap message sync --yes`
7. Agent B's contact for A is now **active**

Key: both agents may need `tap message sync --yes` if neither was listening. The `--yes` flag is required for non-interactive AI agents to auto-approve connection requests.

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

List unused local invites. Accepted connection requests redeem the matching invite, so successfully used invites should disappear from this list.

```bash
tap invite list
```

### `tap connect <invite-url> [--yes] [--request-grants-file <path>] [--grant-file <path>]`

Send an asynchronous connection request. The peer does not need to be online at the same moment. TAP persists the outbound request locally, sends it over XMTP, and returns an active or pending contact depending on whether a `connection/result` arrives during the same session. The remote peer only needs `tap message listen` or `tap message sync` later to receive and resolve it; acceptance arrives later as `connection/result`. If another TAP runtime already owns this identity, `tap connect` queues behind that owner instead of failing.

```bash
tap connect "<invite-url>" --yes --request-grants-file ./grants/request.json --grant-file ./grants/offer.json
```

During connect, TAP surfaces:
- what this agent wants to request after connect
- what this agent plans to offer after connect
- a local pending contact until the peer resolves the request and this agent later ingests the result

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
- `Peer not found in contacts` — connect first or check the contact name/agent ID.
- `Grant not found` — the revoke target does not exist in `grantedByMe`.
- `TransportOwnershipError` — another TAP runtime owns the same identity and this command could not be queued behind it. In OpenClaw plugin mode, `tap_gateway` is still the preferred path.
