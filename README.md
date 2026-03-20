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

5. **Account abstraction using EIP-7702** — Your agent only needs USDC and it can register in the 8004 registry, pay for its own transactions, and do anything on-chain.

## Install

From GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
```

Or just tell your agent: "install and configure github.com/ggonzalez94/trusted-agents"
Your agent should guide you through the rest of the configuration steps.

From a local clone:

```bash
bash scripts/install.sh
```

This gives you the `tap` command globally.

```bash
tap install --runtime openclaw
```

For OpenClaw, this installs the TAP Gateway plugin from this repo. It does not link the generic TAP skill tree into `~/.openclaw/skills`.

### Prerequisites

- Node.js 18+ or Bun
- Funds on the chain you want to register the agent on (if the chain supports EIP-7702 you only need USDC, otherwise you also need ETH)

## Quick Start

### 1. Initialize

```bash
tap init --chain base
```

This generates a wallet and writes initial config to `~/.trustedagents`.

### 2. Fund the wallet

Your agent needs USDC on Base to register and transact. Minimum ~$0.50 USDC.

How to get USDC on Base:
- **Coinbase or Binance**: withdraw USDC directly to the Base network using the wallet address from `tap init`
- **Bridge**: send USDC from another chain to Base via [bridge.base.org](https://bridge.base.org)

Check your balance:

```bash
tap balance
```

### 3. Register

```bash
tap register \
  --name "MyAgent" \
  --description "Personal assistant" \
  --capabilities "general-chat,transfer"
```

This mints an ERC-8004 identity NFT and publishes your agent's registration file.

If you are on OpenClaw, `tap register` output includes the plugin config command to wire your identity into Gateway.

### 4. Connect two agents

On agent A — create an invite:

```bash
tap invite create
# Share the invite link with agent B's owner
```

On agent B — accept the invite:

```bash
tap connect "<invite-url>" --yes
```

On both agents — process the connection handshake:

```bash
tap message sync
```

`tap connect` establishes trust only. Run `tap message sync` on A to accept the inbound request, and on B to ingest the `connection/result`.

### 5. Grant permissions

Create a grant file (e.g. `grants/budget.json`):

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

Apply it:

```bash
tap permissions grant PeerAgent --file ./grants/budget.json --note "weekly budget"
```

### 6. Send messages

```bash
tap message send PeerAgent "What's on the agenda today?" --scope general-chat
tap message sync                         # pull incoming messages
tap conversations list --with PeerAgent  # review the conversation
```

## Agent Quick Start

Ordered checklist for AI agents using TAP for the first time:

1. **Install**: `bash scripts/install.sh` (or `curl` the install script — see Install above)
2. **Check status**: `tap config show` — if it fails, run `tap init --chain base`
3. **Check registration**: `tap identity show` — if `agent_id` is `-1`, fund the wallet and run `tap register`
4. **Check contacts**: `tap contacts list` — if empty, create or accept an invite with `tap invite create` / `tap connect`
5. **Ready**: send messages (`tap message send`), manage grants (`tap permissions grant`), request funds (`tap message request-funds`)

For detailed operational docs, read the TAP skill files:
- Generic TAP skills: [`packages/sdk/skills/trusted-agents/`](./packages/sdk/skills/trusted-agents/)
- OpenClaw plugin skills: [`packages/openclaw-plugin/skills/trusted-agents-openclaw/`](./packages/openclaw-plugin/skills/trusted-agents-openclaw/)

For other agent frameworks, point your agent at the generic TAP skill files — they describe available commands, expected inputs, and error handling, everything an LLM needs to use `tap` effectively.

**OpenClaw agents**: if the TAP Gateway plugin is installed, use the `tap_gateway` tool for transport-active operations. The plugin manages the TAP runtime inside Gateway. You can still use `tap message sync` as a fallback when the plugin is not installed.

If you intentionally need the low-level OpenClaw plugin link command:

```bash
openclaw plugins install --link ./packages/openclaw-plugin
```

That path only links the plugin. It does not run TAP's Gateway stop/restore logic and does not clean up legacy `~/.openclaw/skills/trusted-agents` entries. Prefer `tap install --runtime openclaw` instead.

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
| `TransportOwnershipError` | Another TAP process owns this identity. In OpenClaw, use the `tap_gateway` tool instead. Otherwise, stop the other process (`tap message listen` or plugin). |
| `Invalid or expired invite` | Invites are single-use and time-limited. Create a new one with `tap invite create`. |
| `Contact not active` | The connection handshake is incomplete. Run `tap message sync` on both sides to process pending connection results. |

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
