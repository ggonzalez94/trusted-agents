# Permissions V1

## Model

- A connection creates trust and contact state.
- Grants are published after connect and are directional per peer.
- `grantedByMe` means what the peer may ask this agent to do.
- `grantedByPeer` means what this agent may ask the peer to do.
- The agent judges requests at runtime using grants plus local notes.

## Grant File Format

Use either:
- a top-level array of grants
- or a full grant set object

Full object example:

```json
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "worker-weekly-usdc",
      "scope": "transfer/request",
      "constraints": {
        "asset": "usdc",
        "maxAmount": "10",
        "window": "week"
      }
    },
    {
      "grantId": "worker-chat",
      "scope": "general-chat"
    }
  ]
}
```

Grant fields:
- `grantId`: stable identifier used for revocation
- `scope`: stable action or conversation label
- `constraints`: optional JSON object
- `status`: optional, defaults to `active`
- `updatedAt`: optional ISO timestamp

## Recommended Scope Names

- `general-chat`
- `research`
- `scheduling`
- `transfer/request`
- `permissions/request-grants`

Use stable scope names and put budgets, assets, time windows, or policy details inside `constraints`.
