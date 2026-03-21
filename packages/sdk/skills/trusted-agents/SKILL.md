---
name: trusted-agents
description: Operate a Trusted Agents Protocol agent with the `tap` CLI — install, onboard, connect to other agents, manage permissions, send messages, and request funds. Use this skill whenever the user wants to work with TAP, set up an agent identity, connect agents, exchange grants, or do anything involving agent-to-agent communication or on-chain identity — even if they don't explicitly say "TAP."
---

# Trusted Agents Protocol

TAP gives your AI agent a verifiable on-chain identity so it can connect, message, and transact with other agents. It combines ERC-8004 on-chain registration with XMTP encrypted messaging and a directional permission system. Think of it as a secure contact list where each contact comes with explicit permissions for what you can ask each other to do.

## Action-First Rule

Execute commands before asking questions. When a user asks to install, set up, or use TAP:

1. Run the status check immediately — don't explain what you're about to do
2. Let the command outputs tell you what's needed next
3. Only ask the user when you genuinely need their input
4. Ask **one question at a time**, act on the answer, then continue

Do not present overviews, tables, or summaries of TAP before acting. Do not bundle multiple questions into one message.

## Status Check

Run these to figure out where things stand:

```
which tap            → Not found? See Install
tap config show      → Errors? Start at Onboard step 1
tap identity show    → agent_id < 0? Resume Onboard (fund + register)
tap balance          → Check funding
tap contacts list    → Empty? See Connect
```

Decision flow:

```
tap not installed ──→ Install
        │
   config fails ──→ Onboard (init + fund + register)
        │
   agent_id < 0 ──→ Onboard (fund + register)
        │
   no contacts ──→ Connect (invite or connect)
        │
   waiting on async ──→ tap message sync
        │
   ready ──→ message, transfer, manage permissions
```

## Install

From within this repo:

```bash
bash scripts/install.sh
```

Remote install (no clone needed):

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
```

The installer builds, links `tap` to PATH, and sets up skills for your host. After install, continue with Onboard.

## Onboard

Already registered? `tap config show` shows `agent_id >= 0` → skip to Connect.

### Step 1: Create the wallet

```bash
tap init --chain base
```

This generates a fresh wallet and local config.

**Chain rules:** Default to `base` (Base mainnet) without asking. Only offer `taiko` (Taiko mainnet) if the user explicitly asks for an alternative. **Never suggest, mention, or present testnets** (`base-sepolia`, `taiko-hoodi`) — not in tables, options, or comparisons. They don't exist as far as onboarding is concerned.

### Step 2: Fund the wallet

Show the user their wallet address from the `tap init` output. Ask them to fund it with **~0.50 USDC on Base**.

- On Base, only USDC is needed — gas is covered by EIP-7702 with Circle Paymaster. No ETH required.
- On Taiko, native gas tokens are used instead.
- IPFS upload (for the registration file) also pays with Base mainnet USDC via x402.

Confirm with `tap balance` before continuing.

### Step 3: Register on-chain

Ask the user for these inputs **one at a time** — don't bundle them:

1. **Name** — a display name like "TreasuryAgent"
2. **Description** — a short phrase like "Payment and expense agent"
3. **Capabilities** — public discovery labels that tell other agents what this one can do

Suggest a default based on what the user has described so far:

| Archetype | Suggested capabilities |
|---|---|
| General assistant | `general-chat` |
| Payment / treasury | `transfer,general-chat` |
| Research agent | `research,general-chat` |
| Full-featured | `transfer,research,general-chat` |

Then register:

```bash
tap register --name "TreasuryAgent" --description "Payment agent" --capabilities "transfer,general-chat"
```

Registration uploads the agent's metadata to IPFS and registers an ERC-8004 token on-chain. When it completes, the agent is live and ready to connect.

To update a registration later:

```bash
tap register update --capabilities "transfer,research,general-chat"
```

## Connect

Connections establish trust between two agents. They don't grant permissions — that's a separate step.

1. Agent A creates an invite: `tap invite create`
2. Agent B connects with it: `tap connect "<invite-url>" --yes`
3. Agent A picks up the request (via sync or listener) and auto-accepts valid invites
4. Both agents now have an **active** contact

This is async — agents don't need to be online at the same time. Run `tap message sync` to pick up pending connection results.

```bash
tap invite create --expiry 3600
tap connect "<invite-url>" --yes --wait 60
tap contacts list
tap contacts show WorkerAgent
tap contacts remove <connectionId>
```

`--wait` polls for the connection to become active (default: 60s). Without it, returns immediately as `pending`.

## Permissions

Connections create trust. **Grants** define what each side is allowed to ask the other to do.

- `grantedByMe` — what the peer may ask **this** agent to do
- `grantedByPeer` — what **this** agent may ask the peer to do
- Capabilities (from registration) are public discovery labels, not permissions
- Grants are the real authorization mechanism

```bash
tap permissions show WorkerAgent
tap permissions grant WorkerAgent --file ./grants.json --note "weekly payment policy"
tap permissions request TreasuryAgent --file ./request.json --note "need weekly budget"
tap permissions revoke WorkerAgent --grant-id worker-weekly-usdc --note "budget paused"
```

### Grant templates

**Chat only:**
```json
[{ "grantId": "peer-chat", "scope": "general-chat" }]
```

**USDC weekly budget:**
```json
[{
  "grantId": "peer-weekly-usdc",
  "scope": "transfer/request",
  "constraints": { "asset": "usdc", "maxAmount": "50", "window": "week" }
}]
```

**Chat + research:**
```json
[
  { "grantId": "peer-chat", "scope": "general-chat" },
  { "grantId": "peer-research", "scope": "research" }
]
```

See `references/permissions-v1.md` for the full JSON spec with all fields and additional templates.

| Scope | Purpose |
|---|---|
| `general-chat` | Conversational exchange |
| `research` | Questions, information gathering |
| `scheduling` | Calendar actions |
| `transfer/request` | Value movement |
| `permissions/request-grants` | Ask for permissions |

## Messages

- **`tap message sync`** — one-shot reconciliation. Default for AI agents and scheduled runtimes. Safe alongside other processes.
- **`tap message listen`** — long-lived XMTP stream. Use only when one dedicated process exclusively owns the identity.

Keep exactly one transport owner per TAP identity.

After syncing, proactively relay what arrived — don't wait for the user to ask "what did they say?" Read the conversation and tell them what the peer said.

```bash
tap message send WorkerAgent "Status update?" --scope general-chat
tap message sync
tap message listen
tap conversations list --with TreasuryAgent
tap conversations show conv-abc123
```

## Transfer Requests

Transfer requests ask a peer to send ETH or USDC. TAP hard-blocks execution unless a matching active grant exists — there is no override.

```bash
tap message request-funds TreasuryAgent --asset usdc --amount 5 --chain base --note "weekly research budget"
```

Flow: send request → peer evaluates against grants → auto-approve if covered, operator review if not → result arrives on next sync.

Before approving inbound transfers, inspect `tap permissions show <peer>` and `<dataDir>/notes/permissions-ledger.md`.

## Utility Commands

```bash
tap balance [chain]                    # ETH + USDC balances
tap config show                        # Resolved config (secrets redacted)
tap config set <key> <value>           # Update one config value
tap identity show                      # Wallet address, agent ID, chain
tap identity resolve <id> [chain]      # Look up another agent
tap identity resolve-self              # Check own published registration
tap install                            # Auto-detect host
tap install --runtime claude           # Claude Code skill install
tap install --runtime openclaw         # OpenClaw plugin install
tap remove --dry-run                   # Preview what would be deleted
tap remove --unsafe-wipe-data-dir --yes  # Wipe the data dir
```

`tap remove` is local only — does not unregister on-chain or notify peers.

## Common Errors

| Error | Fix |
|---|---|
| `agent_id` missing or < 0 | Complete onboarding — fund wallet and register |
| `Invalid chain format` | Use `base`, `taiko`, or CAIP-2 format (`eip155:8453`) |
| `Agent not found on-chain` | Check chain and agent ID |
| `TransportOwnershipError` | Another process owns this identity — use it, stop it, or use `tap message sync` |
| `Insufficient funds` | Fund the wallet with USDC (Base) or native gas (other chains) |
| `Invalid or expired invite` | Create a fresh invite |
| `Contact not active yet` | Peer hasn't synced — run `tap message sync` |
| `Peer not found in contacts` | Connect first or check the name/agent ID |
| `Grant not found` | The revoke target doesn't exist — check `tap permissions show` |
| `tap remove` blocked | Stop the live transport owner first |
