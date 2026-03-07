# tap

Local-first CLI and SDK for the Trusted Agent Protocol.

TAP currently provides:
- ERC-8004 on-chain agent identity
- XMTP transport for agent-to-agent JSON-RPC messages
- Local trust storage, conversation logs, and a permissions ledger
- Directional grant sharing between connected agents
- An optional OpenClaw plugin that runs TAP as a Gateway background service

## Core Model

- Capabilities are public labels in the on-chain registration file.
- `tap connect` establishes trust only.
- Business permissions are directional grants stored per contact:
  - `grantedByMe`
  - `grantedByPeer`
- Grants are context for runtime agent judgment. TAP does not hard-enforce business rules in the CLI.

## Prerequisites

- Node.js 18+ or Bun
- ETH on the registration chain for gas
- Base mainnet USDC only if using x402 for IPFS upload

## Install

```bash
bun install
bun run build
cd packages/cli && npm link
```

OpenClaw plugin install from this repo:

```bash
openclaw plugins install -l ./packages/openclaw-plugin
```

Then point OpenClaw at an existing TAP data dir:

```bash
openclaw config set plugins.entries.trusted-agents-tap.config.identities '[{"name":"default","dataDir":"/absolute/path/to/tap-data","reconcileIntervalMinutes":10}]' --json
```

Restart the Gateway after plugin config changes. In plugin mode, use `tap_gateway` for transport-active TAP work and keep the normal `tap` CLI for onboarding and read-only inspection.

Or run directly:

```bash
node packages/cli/dist/bin.js <command>
```

## Quick Start

### 1. Initialize an agent

```bash
tap init
```

This creates a wallet, config, and local state under the TAP data directory.

### 2. Fund the wallet

- Send ETH on the registration chain for gas.
- Send Base mainnet USDC only if you will use x402 IPFS upload.

Check the wallet:

```bash
tap identity show
tap balance
```

### 3. Register on-chain

```bash
tap register \
  --name "TreasuryAgent" \
  --description "Payment agent" \
  --capabilities "payments,general-chat"
```

Alternatives:

```bash
tap register --name "TreasuryAgent" --description "Payment agent" --capabilities "payments,general-chat" --pinata-jwt "$TAP_PINATA_JWT"
tap register --name "TreasuryAgent" --description "Payment agent" --capabilities "payments,general-chat" --uri "https://example.com/agent.json"
```

### 4. Create an invite

On the inviting agent:

```bash
tap invite create
```

Runtime choice:

- OpenClaw with plugin: use the `tap_gateway` tool after the plugin is configured.
- Scheduler-driven host or heartbeat: run `tap message sync` at the start of each turn.
- Dedicated always-on TAP owner process: run `tap message listen`.

### 5. Connect and exchange initial grants

On the joining agent:

```bash
tap connect "<invite-url>" --yes
```

Optional initial grant exchange:

```bash
tap connect "<invite-url>" \
  --yes \
  --request-grants-file ./grants/request.json \
  --grant-file ./grants/offer.json
```

Example grant file:

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
    }
  ]
}
```

### 6. Inspect or update grants later

```bash
tap permissions show
tap permissions show TreasuryAgent
tap permissions request TreasuryAgent --file ./grants/request.json --note "need weekly budget"
tap permissions grant WorkerAgent --file ./grants/offer.json --note "approved weekly budget"
tap permissions revoke WorkerAgent --grant-id worker-weekly-usdc --note "budget paused"
```

### 7. Send messages and value requests

```bash
tap message send TreasuryAgent "Status update?" --scope general-chat
tap message request-funds TreasuryAgent --asset usdc --amount 5 --chain base --note "weekly research budget"
tap message sync
tap conversations list --with TreasuryAgent
```

## Runtime Modes

- `tap message sync` is the portable correctness baseline and the default for heartbeat/scheduled hosts.
- `tap message listen` is for dedicated long-lived TAP owner processes only.
- The OpenClaw plugin makes streaming the default inside Gateway and exposes the `tap_gateway` tool for transport-active operations.
- Treat plugin mode as active only when `tap_gateway` action `status` shows at least one configured identity.
- Keep exactly one transport owner per TAP identity and `dataDir`.
- In plugin mode, avoid transport-active `tap` CLI commands against the same `dataDir`.

## Commands

### Onboarding

- `tap init [--private-key <hex>] [--chain <name>]`
- `tap register --name <name> --description <desc> --capabilities <list> [--pinata-jwt <token>] [--uri <url>]`
- `tap register update [--name <name>] [--description <desc>] [--capabilities <list>] [--pinata-jwt <token>] [--uri <url>]`
- `tap balance [chain]`

### Identity and config

- `tap config show`
- `tap config set <key> <value>`
- `tap identity show`
- `tap identity resolve <agentId> [chain]`
- `tap identity resolve-self [chain]`

### Connections and grants

- `tap invite create [--expiry <seconds>]`
- `tap invite list`
- `tap connect <invite-url> [--yes] [--request-grants-file <path>] [--grant-file <path>]`
- `tap permissions show [peer]`
- `tap permissions grant <peer> --file <path> [--note <text>]`
- `tap permissions request <peer> --file <path> [--note <text>]`
- `tap permissions revoke <peer> --grant-id <id> [--note <text>]`
- `tap contacts list`
- `tap contacts show <name-or-id>`
- `tap contacts remove <connectionId>`

### Messaging

- `tap message send <peer> <text> [--scope <scope>]`
- `tap message request-funds <peer> --asset <native|usdc> --amount <amount> [--chain <chain>] [--to <address>] [--note <text>]`
- `tap message sync [--yes] [--yes-actions]`
- `tap message listen [--yes] [--yes-actions]`
- `tap conversations list [--with <name>]`
- `tap conversations show <id>`

## Data Directory

All agent-local state lives under one root:

```text
<dataDir>/
├── config.yaml
├── identity/agent.key
├── contacts.json
├── pending-invites.json
├── ipfs-cache.json
├── conversations/<id>.json
├── notes/permissions-ledger.md
└── xmtp/<inboxId>.db3
```

Resolution order:
- `--data-dir`
- `TAP_DATA_DIR`
- `~/.local/share/trustedagents` if it exists
- `~/.trustedagents`

Using a separate `TAP_DATA_DIR` fully isolates one local agent from another.

## Environment Variables

- `TAP_AGENT_ID`
- `TAP_CHAIN`
- `TAP_PRIVATE_KEY`
- `TAP_DATA_DIR`
- `TAP_PINATA_JWT`

## Development

```bash
bun run lint
bun run typecheck
bun run test
XMTP_INTEGRATION=true bun run test:xmtp
```
