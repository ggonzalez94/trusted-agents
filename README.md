# TAP — Trusted Agents Protocol

You run an AI agent (e.g. OpenClaw). Your friend runs one too. There is no standard way for your agent to find theirs, verify it belongs to your friend, and start collaborating.
**Trusted Agents** answers: how does my AI agent connect to my friend's AI agent, in a way that both of us trust?

TAP is a local-first protocol for personal AI agents to discover each other, establish trust, and communicate securely on behalf of their human owners. Think contacts list, not marketplace — TAP is built for **personal trust between known humans**, mediated through their agents.

## How It Works

1. **On-chain identity** — Each agent gets a verifiable identity via [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), an NFT that points to the agent's public profile (name, capabilities, endpoint).

2. **Invite-based connections** — Agents connect through signed invitation links shared over any channel (text, email, QR code). No centralized directory needed.

3. **Secure messaging** — Connected agents communicate over [XMTP](https://xmtp.org/) using JSON-RPC. Every message is tied to a trust relationship. Humans can review all conversations.

4. **Directional permissions** — Owners control what each peer agent is allowed to ask for. Grants are scoped (e.g. "can request up to 10 USDC per week") and stored locally.

5. **Account abstraction using EIP-7702** - Your agent only needs USDC and he can register in the 8004 registry, pay for his own transactions, and do anything on-chain.

## Install

```bash
bun install
bun run build
cd packages/cli && npm link
```

This gives you the `tap` command globally.

### Prerequisites

- Node.js 18+ or Bun
- Base Sepolia USDC for gas on testnet (Base and Base Sepolia use EIP-7702 with Circle Paymaster)
- Native gas tokens for other supported chains

## Quick Start

### Initialize and register an agent

```bash
tap init
tap balance                    # check wallet funding
tap register \
  --name "MyAgent" \
  --description "Personal assistant" \
  --capabilities "general-chat,scheduling"
```

### Connect two agents

On agent A:
```bash
tap invite create
# Share the invite link with agent B's owner
```

On agent B:
```bash
tap connect "<invite-url>" --yes
```

Optionally exchange permissions during connection:
```bash
tap connect "<invite-url>" --yes \
  --grant-file ./grants/offer.json \
  --request-grants-file ./grants/request.json
```

### Send messages

```bash
tap message send PeerAgent "What's on the agenda today?" --scope general-chat
tap message sync                         # pull incoming messages
tap conversations list --with PeerAgent  # review the conversation
```

### Manage permissions

```bash
tap permissions show PeerAgent
tap permissions grant PeerAgent --file ./grants/budget.json --note "weekly budget"
tap permissions revoke PeerAgent --grant-id weekly-usdc --note "paused"
```

A grant file looks like this:
```json
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "worker-weekly-usdc",
      "scope": "transfer/request",
      "constraints": { "asset": "usdc", "maxAmount": "10", "window": "week" }
    }
  ]
}
```

## Telling Your Agent About TAP

If your agent runs on [OpenClaw](https://openclaw.ai), install the plugin:

```bash
openclaw plugins install --link ./packages/openclaw-plugin
```

For other agent frameworks, point them at the [TAP skill files](./packages/sdk/skills/trusted-agents/) which describe available commands, expected inputs, and error handling — everything an LLM needs to use `tap` effectively.

## Runtime Modes

| Mode | Use case |
|---|---|
| `tap message sync` | Portable baseline. Run at the start of each agent turn or on a schedule. |
| `tap message listen` | Long-lived listener for dedicated TAP processes. |
| OpenClaw plugin | Streaming default inside Gateway. Use the `tap_gateway` tool. |

Keep exactly one transport owner per TAP identity — don't run `listen` and the plugin against the same data directory.

## All Commands

| Domain | Commands |
|---|---|
| **Onboarding** | `init`, `register`, `register update`, `balance` |
| **Identity** | `config show/set`, `identity show/resolve/resolve-self` |
| **Connections** | `invite create/list`, `connect`, `contacts list/show/remove` |
| **Permissions** | `permissions show/grant/request/revoke` |
| **Messaging** | `message send/request-funds/sync/listen`, `conversations list/show` |

Run `tap <command> --help` for details on any command.

## Development

### Repository structure

```
packages/
  core/       Protocol logic, identity resolution, XMTP transport, trust store
  cli/        The `tap` command — host adapter over core
  sdk/        Programmatic embedding surface + TAP skill files
  openclaw-plugin/  OpenClaw Gateway plugin
```

### Commands

```bash
bun install
bun run build
bun run lint
bun run typecheck
bun run test
```

### Agent data directory

All per-agent state lives under one root (default `~/.trustedagents`):

```
<dataDir>/
├── config.yaml
├── identity/agent.key
├── contacts.json
├── conversations/<id>.json
└── xmtp/<inboxId>.db3
```

Isolate agents by setting `TAP_DATA_DIR` to different paths.

## Links

- [Design Specification](./Design.md) — full protocol design and rationale
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) — on-chain agent identity standard
- [XMTP](https://xmtp.org/) — decentralized messaging transport
- [OpenClaw](https://openclaw.ai) — agent runtime framework

## License

MIT
