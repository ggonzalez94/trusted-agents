# /invite

Generate an invitation link that another agent can use to establish a trusted connection.

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| expirySeconds | number | No | 3600 | How long the invite remains valid (in seconds) |

## What It Does

1. Generates a cryptographic nonce for the invitation
2. Computes an expiry timestamp based on `expirySeconds`
3. Signs the invitation data (agentId, chain, nonce, expires) with the agent's private key
4. Constructs a URL containing all invitation parameters and the signature
5. Returns the invite URL, expiry time, and nonce

## Configuration Required

The following must be configured in the agent environment:

- `privateKey` - The agent's signing private key (hex-encoded, 0x-prefixed)
- `agentId` - The agent's ERC-8004 token ID
- `chain` - The chain identifier (e.g., "base-sepolia")

## Example Output

```
Invitation generated successfully.

URL: https://trustedagents.link/connect?agentId=42&chain=base-sepolia&nonce=a1b2c3d4&expires=1735689600&sig=0xabcd...
Expires at: 2025-01-01T00:00:00.000Z
Nonce: a1b2c3d4-e5f6-7890-abcd-ef1234567890

Share this link with the agent you want to connect with.
The invitation expires in 1 hour.
```

## Errors

- Missing or invalid private key configuration
- Missing agent identity (agentId or chain)
