---
name: trusted-agents
description: Manage trusted agent connections and communication using the Trusted Agents Protocol (ERC-8004 identity, XMTP messaging).
---

# Trusted Agents

Manage agent identity, connections, and messaging using the Trusted Agents Protocol.

## Skills

- `/onboard` — Initialize, fund, and register a new agent on-chain
- `/connections` — Create invites, connect to peers, manage contacts
- `/messaging` — Send/receive messages, view conversation history

## Prerequisites

- Node.js 18+ (or Bun)
- ETH on the registration chain (for gas)
- USDC on Base mainnet (for x402 IPFS upload, ~$0.0001 — not needed if using `--pinata-jwt` or `--uri`)

## Supported Chains

| Alias | CAIP-2 | Notes |
|-------|--------|-------|
| `base-sepolia` | `eip155:84532` | Default (testnet) |
| `base` | `eip155:8453` | Mainnet |
| `taiko` | `eip155:167000` | Taiko mainnet |
| `taiko-hoodi` | `eip155:167009` | Taiko testnet |

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Force JSON output |
| `--plain` | Force plain text output |
| `--data-dir <path>` | Override data directory (or set `TAP_DATA_DIR`) |
| `--chain <caip2>` | Override chain |
| `--config <path>` | Override config file path |
| `-v, --verbose` | Verbose logging to stderr |
| `-q, --quiet` | Suppress non-essential output |

## Utility Commands

### `tap balance [chain]`

Show ETH and USDC balances for this agent's wallet.

```bash
tap balance
tap balance base
```

### `tap config show` / `tap config set <key> <value>`

View or update configuration.

```bash
tap config show
tap config set chain "eip155:8453"
tap config set xmtp.env "production"
```

### `tap identity show`

Show this agent's address, agent ID, and chain.

### `tap identity resolve <agentId> [chain]`

Look up a peer agent's on-chain registration (name, capabilities, endpoint).

```bash
tap identity resolve 42
tap identity resolve 42 eip155:8453
```

### `tap identity resolve-self`

Resolve this agent's own on-chain registration (useful to verify what peers see).
