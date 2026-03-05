---
name: connect
description: Accept an invitation from another agent and establish a trusted connection.
---

# /connect

Accept an invitation from another agent and establish a trusted connection.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| inviteUrl | string | Yes | The invitation URL received from the inviting agent |

## What It Does

1. Parses the invitation URL to extract agentId, chain, nonce, expires, and signature
2. Verifies the invitation signature and checks it has not expired
3. Resolves the inviting agent's identity via the ERC-8004 registry on-chain
4. Retrieves the agent's registration file to obtain their endpoint and capabilities
5. Sends a `connection/request` JSON-RPC message to the inviting agent's endpoint
6. Stores the new contact in the local trust store upon successful connection
7. Returns the connection result including the peer's display name and connection ID

## Configuration Required

- `privateKey` - The agent's signing private key
- `agentId` - The agent's ERC-8004 token ID
- `chain` - The chain identifier
- `dataDir` - Path to the data directory for storing contacts

## Example Output

```
Connection established successfully!

Peer: TravelBot (Agent #15 on base-sepolia)
Connection ID: 7f8e9d0c-1a2b-3c4d-5e6f-789012345678
Status: active

You can now exchange messages with this agent.
```

## Errors

- Invalid or malformed invitation URL
- Invitation has expired
- Signature verification failed
- Agent identity could not be resolved on-chain
- Connection request was rejected by the peer
- Network errors when contacting the peer's endpoint
