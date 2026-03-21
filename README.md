# TAP — Trusted Agents Protocol

You run an AI agent (e.g. OpenClaw). Your friend runs one too. There is no standard way for your agent to find theirs, verify it belongs to your friend, and start collaborating.
**Trusted Agents** answers: how does my AI agent connect to my friend's AI agent, in a way that both of us trust?

TAP is a local-first protocol for personal AI agents to discover each other, establish trust, and communicate securely on behalf of their human owners. Think contacts list, not marketplace — TAP is built for **personal trust between known humans**, mediated through their agents.

<img width="720" height="720" alt="ChatGPT Image Mar 9, 2026, 08_39_48 AM" src="https://github.com/user-attachments/assets/ab12002e-7338-4aab-b9ee-a1c2874cc19e" />

## How It Works

1. **On-chain identity** — Each agent gets a verifiable identity via [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), an NFT that points to the agent's public profile (name, capabilities, endpoint).

2. **Invite-based connections** — Agents connect through signed invitation links shared over any channel (text, email, QR code). No centralized directory needed.

3. **Secure messaging** — Connected agents communicate over [XMTP](https://xmtp.org/) using JSON-RPC. Every message is tied to a trust relationship. Humans can review all conversations.

4. **Directional permissions** — Owners control what each peer agent is allowed to ask for. Grants are scoped (e.g. "can request up to 10 USDC per week") and stored locally.

5. **Account abstraction using EIP-7702 or ERC-4337** — Your agent only needs USDC and it can register in the 8004 registry, pay for its own transactions, and do anything on-chain.

## Get Started

### Agent mode

Copy-paste this to your AI agent:

> Read the TAP skill at https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/packages/sdk/skills/trusted-agents/SKILL.md and then follow it to install TAP and set me up.

The skill teaches your agent how to install the `tap` CLI, create an on-chain identity, fund it, and register — walking you through each decision one step at a time.

If your agent already has the TAP skill installed (via `tap install`), you can just say:

> Install Trusted Agents Protocol from github.com/ggonzalez94/trusted-agents and set me up.

### Manual mode

<details>
<summary>Step-by-step instructions for humans or agents without skill support</summary>

#### Prerequisites

- Node.js 18+ or Bun
- USDC on the chain you want to register on (Base recommended — only needs USDC, no ETH)

#### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
```

From a local clone: `bash scripts/install.sh`

For OpenClaw, also run:

```bash
tap install --runtime openclaw
```

#### 2. Initialize

```bash
tap init --chain base
```

#### 3. Fund the wallet

Your agent needs ~$0.50 USDC on Base to register.

- **Coinbase or Binance**: withdraw USDC directly to Base using the address from `tap init`
- **Bridge**: send USDC from another chain via [bridge.base.org](https://bridge.base.org)

```bash
tap balance    # confirm funding arrived
```

#### 4. Register

```bash
tap register \
  --name "MyAgent" \
  --description "Personal assistant" \
  --capabilities "general-chat,transfer"
```

On OpenClaw, `tap register` output includes the plugin config command — run it to wire your identity into Gateway.

#### 5. Connect two agents

On agent A:
```bash
tap invite create
# Share the invite link with agent B's owner
```

On agent B:
```bash
tap connect "<invite-url>" --yes --wait 60
```

If not using `--wait`, run `tap message sync` on both sides to process the connection handshake.

#### 6. Grant permissions

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

```bash
tap permissions grant PeerAgent --file ./grants/budget.json --note "weekly budget"
```

#### 7. Send messages

```bash
tap message send PeerAgent "What's on the agenda today?" --scope general-chat
tap message sync                         # pull incoming messages
tap conversations list --with PeerAgent  # review the conversation
```

</details>

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
| **Setup** | `install` |
| **Onboarding** | `init`, `register`, `register update`, `balance` |
| **Identity** | `config show/set`, `identity show/resolve/resolve-self` |
| **Connections** | `invite create`, `connect`, `contacts list/show/remove` |
| **Permissions** | `permissions show/grant/request/revoke` |
| **Messaging** | `message send/request-funds/sync/listen`, `conversations list/show` |

Run `tap <command> --help` for details on any command.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Insufficient funds` | Fund your wallet with USDC on Base (minimum ~$0.50). Run `tap balance` to check. |
| `TransportOwnershipError` | Another TAP process owns this identity. In OpenClaw, use `tap_gateway` instead. Otherwise stop the other process. |
| `Invalid or expired invite` | Invites are time-limited. Create a new one with `tap invite create`. |
| `Contact not active` | Connection handshake incomplete. Run `tap message sync` on both sides. |

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
├── request-journal.json
├── pending-connects.json
├── conversations/<id>.json
└── xmtp/<inboxId>.db3
```

Isolate agents by setting `TAP_DATA_DIR` to different paths.

## License

MIT
