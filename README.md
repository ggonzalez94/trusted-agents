# tap — Trusted Agents Protocol CLI

CLI for onboarding and operating agents on the Trusted Agents Protocol. Agents communicate over XMTP and validate each other identity via the ERC-8004 on-chain registry.

## Prerequisites

- Node.js 18+ (or Bun)
- ETH on Base Sepolia (testnet) or Base (mainnet) for registration gas
- USDC on Base for IPFS upload via [x402](https://x402.org) (no account needed), **or** a [Pinata](https://app.pinata.cloud) API key as a fallback

## Install

```bash
# From the monorepo root
bun install
bun run build

# Link the CLI globally
cd packages/cli && npm link
```

Or run directly without installing:

```bash
node packages/cli/dist/bin.js <command>
```

## Quick Start

### 1. Initialize your agent

```bash
tap init
```

This creates:
- A private key at `~/.local/share/trustedagents/identity/agent.key` (mode 0600)
- A config file at `~/.config/trustedagents/config.yaml`
- Data directories for contacts, conversations, and XMTP state

Output includes your **Ethereum address** — this is where you send funds for registration.

To import an existing private key instead of generating one:

```bash
tap init --private-key <hex>
```

### 2. Fund the wallet

The agent's address needs two tokens:
- **ETH on Base Sepolia** — pays for the on-chain registration tx
  - Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
- **USDC on Base mainnet** — pays for IPFS upload via [x402](https://x402.org) (~0.001 USDC)
  - Pinata's x402 endpoint only accepts Base mainnet USDC
  - Alternative: use `--pinata-jwt` to avoid x402 entirely (no USDC needed)

Verify your address anytime with `tap identity show`.

### 3. Register on-chain

```bash
# Just run register — IPFS upload is paid via x402 (USDC), no account needed
tap register \
  --name "MyAgent" \
  --description "An AI assistant for scheduling" \
  --capabilities "scheduling,chat"
```

This does everything:
1. Builds an ERC-8004 registration file with your agent's identity
2. Uploads it to IPFS via x402 (pays with USDC from your wallet — no Pinata account needed)
3. Calls `register(agentURI)` on the ERC-8004 contract
4. Gets back your `agentId` from the Transfer event
5. Auto-updates your config with the new agent ID

**Alternative IPFS options:**

```bash
# Use a Pinata API key instead of x402
tap register --name "MyAgent" --description "..." --capabilities "..." --pinata-jwt "your-jwt"

# Or skip IPFS entirely with a pre-hosted registration file
tap register --name "MyAgent" --description "..." --capabilities "..." --uri "https://example.com/reg.json"
```

### 4. Create an invite

```bash
tap invite create
```

Share the output URL with the peer agent you want to connect with.

### 5. Connect to a peer

On the other agent:

```bash
tap connect <invite-url> --yes
```

### 6. Send a message

```bash
tap message send "PeerName" "hello from my agent"
```

### 7. Listen for messages

```bash
tap message listen
```

Streams incoming messages as JSON lines to stdout. Ctrl+C to stop.

## Commands

```
Setup & Registration
  tap init [--private-key <hex>]        First-time setup (generates or imports wallet)
  tap register [options]                Register on-chain via ERC-8004
  tap register update [options]         Update registration URI/manifest
  tap balance [chain]                   Show native ETH and USDC balances

Identity & Config
  tap config show                       Print resolved config (secrets redacted)
  tap config set <key> <value>          Set a config value (supports dot notation: xmtp.env)
  tap identity show                     Show agent ID, chain, and address
  tap identity resolve <agentId> [chain] Resolve a peer from the on-chain registry
  tap identity resolve-self [chain]     Resolve your own on-chain identity/capabilities

Connections
  tap invite create [--expiry <sec>]    Generate a signed invite link
  tap invite list                       Show pending (unused) invites
  tap connect <url> [--yes]             Accept invite and establish connection
  tap contacts list                     List all contacts
  tap contacts show <name-or-id>        Detail for one contact
  tap contacts remove <connectionId>    Remove a contact

Messaging
  tap message send <peer> <text>        Send a message to a connected peer
  tap message listen                    Stream incoming messages (long-running)
  tap conversations list [--with <name>] Conversation summaries
  tap conversations show <id>           Full conversation transcript
```

### Register Options

| Flag | Description |
|------|-------------|
| `--name <name>` | Agent display name (required) |
| `--description <desc>` | Agent description (required) |
| `--capabilities <list>` | Comma-separated capabilities (required) |
| `--uri <url>` | Pre-hosted registration file (skips IPFS upload) |
| `--pinata-jwt <token>` | Pinata JWT (or set `TAP_PINATA_JWT` env var) |

### Register Update Options

`tap register update` supports two modes:
- URI-only update (no upload): `tap register update --uri <url>`
- Manifest update (auto IPFS upload + on-chain URI update): `tap register update [--name ...] [--description ...] [--capabilities ...]`

When manifest fields are omitted, current on-chain values are preserved.

### Balance

`tap balance` shows the current wallet balances for this agent on one chain:
- native ETH balance
- USDC balance when USDC is configured for that chain

You can pass a chain as either an alias or a CAIP-2 ID:
- `tap balance`
- `tap balance base`
- `tap balance base-sepolia`
- `tap balance taiko`
- `tap balance taiko-hoodi`
- `tap balance eip155:8453`

USDC is currently configured for Base, Base Sepolia, Taiko, and Taiko Hoodi.

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Force JSON envelope output (default when stdout is piped) |
| `--plain` | Force plain text output (default when stdout is a TTY) |
| `--config <path>` | Override config file path |
| `--data-dir <path>` | Override data directory |
| `--chain <caip2>` | Override chain (e.g. `eip155:8453`) |
| `-v, --verbose` | Verbose logging to stderr |
| `-q, --quiet` | Suppress non-essential output |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TAP_AGENT_ID` | Override agent ID |
| `TAP_CHAIN` | Override chain (CAIP-2) |
| `TAP_PRIVATE_KEY` | Private key (instead of keyfile) |
| `TAP_DATA_DIR` | Override data directory |
| `TAP_PINATA_JWT` | Pinata JWT for IPFS uploads (fallback; x402 is default) |

## Configuration

Config file: `~/.config/trustedagents/config.yaml`

```yaml
agent_id: 42
chain: "eip155:84532"
data_dir: "~/.local/share/trustedagents"

xmtp:
  env: "dev"    # "dev" | "production"

chains:
  "eip155:8453":
    rpc_url: "https://mainnet.base.org"
    registry_address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
```

### Resolution order (highest priority wins)

1. CLI flags (`--chain`, `--data-dir`, etc.)
2. Environment variables (`TAP_AGENT_ID`, `TAP_CHAIN`, `TAP_PRIVATE_KEY`, `TAP_DATA_DIR`)
3. Config file
4. Built-in defaults

The private key is never stored in the config file. It's read from `TAP_PRIVATE_KEY` env var or the keyfile at `<data_dir>/identity/agent.key`.

## Data Directory

```
~/.local/share/trustedagents/
  identity/
    agent.key                 # Private key (mode 0600)
  contacts.json               # Trust store
  pending-invites.json        # Invite nonces
  conversations/
    <id>.json                 # Conversation logs
  xmtp/
    <inboxId>.db3             # XMTP client database
```

## Two-Agent Setup Example

**Agent A** (the inviter):

```bash
tap init
# Fund the address with ETH + USDC on Base Sepolia
tap register --name "Agent A" --description "First agent" --capabilities "chat"
tap invite create --expiry 3600
# Copy the URL from the output
```

**Agent B** (the connector):

```bash
tap init
# Fund the address with ETH + USDC on Base Sepolia
tap register --name "Agent B" --description "Second agent" --capabilities "chat"
tap connect "https://trustedagents.link/connect?agentId=1&chain=..." --yes
```

Both agents now have each other as contacts. Send messages:

```bash
# Agent A
tap message send "Agent B" "hello"

# Agent B
tap message listen
```

## ERC-8004 Registration

The `tap register` command creates an [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) registration on-chain. The registration file format:

```json
{
  "type": "eip-8004-registration-v1",
  "name": "MyAgent",
  "description": "What this agent does",
  "services": [
    { "name": "xmtp", "endpoint": "0x<agent-ethereum-address>" }
  ],
  "trustedAgentProtocol": {
    "version": "1.0",
    "agentAddress": "0x<agent-ethereum-address>",
    "capabilities": ["scheduling", "chat"]
  }
}
```

The XMTP service endpoint is the agent's Ethereum address — this is how peers find the agent on the XMTP network. The file is uploaded to IPFS and the `ipfs://` URI is stored on-chain as the `tokenURI`.

Default registry contract: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (Base & Base Sepolia via CREATE2).

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (config, validation) |
| 2 | Usage error (bad arguments) |
| 3 | Network/transport error |
| 4 | Identity/auth error |
| 5 | Permission/connection error |

## JSON Output

All commands produce a standard envelope when `--json` is used or stdout is piped:

```json
{"ok": true, "data": { ... }, "meta": {"duration_ms": 42, "version": "0.1.0"}}
{"ok": false, "error": {"code": "IDENTITY_ERROR", "message": "Unknown chain: ..."}}
```

## Development

```bash
bun install
bun run build       # Build all packages
bun test            # Run all tests
bun run typecheck   # Typecheck all packages
```

### Project Structure

```
packages/
  core/              # Protocol library (identity, transport, trust, connections)
  cli/               # The `tap` CLI binary
  sdk/               # Programmatic SDK for agent integration
```
