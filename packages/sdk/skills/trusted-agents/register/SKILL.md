---
name: register
description: Register or update the agent on-chain via the ERC-8004 identity registry.
---

# /register

Register the agent on-chain via the ERC-8004 identity registry.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | Agent display name (shown to peers) |
| description | string | Yes | What the agent does |
| capabilities | string | Yes | Comma-separated capabilities (see list below) |
| uri | string | No | Pre-hosted registration file URL (skips IPFS) |
| pinata-jwt | string | No | Pinata API JWT (or set `TAP_PINATA_JWT` env var) |

## Capabilities

Capabilities are freeform strings that describe what your agent can do. They are advertised to peers during discovery and used in scope negotiation when establishing connections.

**Common capabilities:**

| Capability | Description |
|------------|-------------|
| `general-chat` | General-purpose conversation |
| `scheduling` | Calendar management, reminders, meeting coordination |
| `research` | Web search, information gathering, summarization |
| `purchases` | Shopping, price comparison, order management |
| `file-sharing` | File transfer between agents |

You can also define custom capabilities (any string works):
- `code-review`, `translation`, `data-analysis`, `image-generation`, etc.

Declare capabilities that match what your agent actually does — peers use these to decide whether to connect.

## What It Does

1. Loads the agent's private key and derives the Ethereum address
2. Constructs an ERC-8004 registration file:
   ```json
   {
     "type": "eip-8004-registration-v1",
     "name": "MyAgent",
     "description": "...",
     "services": [
       { "name": "xmtp", "endpoint": "0x<agent-address>" }
     ],
     "trustedAgentProtocol": {
       "version": "1.0",
       "agentAddress": "0x<agent-address>",
       "capabilities": ["scheduling", "chat"]
     }
   }
   ```
3. Validates the file against the ERC-8004 schema
4. Uploads to IPFS via x402 (pays with USDC, no account needed) or Pinata JWT, or uses provided `--uri`
5. Calls `register(agentURI)` on the ERC-8004 contract
6. Waits for the transaction receipt
7. Extracts the assigned `agentId` from the `Transfer` event
8. Updates `config.yaml` with the new `agent_id`

## Prerequisites

- `tap init` must have been run (keyfile must exist)
- The agent's wallet needs ETH (gas) and USDC (IPFS upload via x402) on the target chain
- Alternatively: provide `--pinata-jwt` for authenticated IPFS upload, or `--uri` for a pre-hosted file

## Example

```bash
# Default: x402 pays for IPFS with USDC from your wallet (no account needed)
tap register \
  --name "SchedulerBot" \
  --description "Manages calendar and scheduling for the team" \
  --capabilities "scheduling,general-chat"
```

Output:
```json
{
  "ok": true,
  "data": {
    "agent_id": 42,
    "chain": "eip155:84532",
    "address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "agent_uri": "ipfs://QmXyz...",
    "ipfs_cid": "QmXyz...",
    "next_steps": [
      "Your agent is registered on-chain as #42",
      "Run 'tap invite create' to generate an invite link"
    ]
  }
}
```

## Updating Registration

To update name, description, capabilities, or the registration file URI:

```bash
tap register update \
  --name "SchedulerBot v2" \
  --description "Updated description" \
  --capabilities "scheduling,reminders,calendar,notifications"
```

This calls `setAgentURI(agentId, newURI)` on the contract. Only the agent owner can update.

## ERC-8004 Registration File Format

The registration file is a JSON document stored at the `agentURI` on-chain. Required fields:

| Field | Description |
|-------|-------------|
| `type` | Must be `"eip-8004-registration-v1"` |
| `name` | Non-empty agent display name |
| `description` | Agent description |
| `services` | Array with at least one `xmtp` service |
| `trustedAgentProtocol.version` | Protocol version (currently `"1.0"`) |
| `trustedAgentProtocol.agentAddress` | Must match the XMTP service endpoint |
| `trustedAgentProtocol.capabilities` | Array of capability strings |

The XMTP service endpoint is the agent's Ethereum address — this is how other agents find this agent on the XMTP network.

## Errors

- `agent_id is required` — use `tap register` (not other commands) before registration
- `Insufficient funds` — send ETH to the wallet address shown by `tap identity show`
- `Pinata upload failed` — invalid or expired JWT token
- `XMTP service endpoint must match agentAddress` — internal consistency error
- `Transfer event not found` — transaction succeeded but couldn't parse the agentId
