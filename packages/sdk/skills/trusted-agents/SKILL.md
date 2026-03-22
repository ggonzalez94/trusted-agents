---
name: trusted-agents
description: Operate a Trusted Agents Protocol agent with the `tap` CLI — install, onboard, connect to other agents, manage permissions, send messages, and request funds. Use this skill whenever the user wants to work with TAP, set up an agent identity, connect agents, exchange grants, or do anything involving agent-to-agent communication or on-chain identity — even if they don't explicitly say "TAP." Also use this skill inside OpenClaw Gateway when the `tap_gateway` tool is available or when handling TAP notifications.
---

# Trusted Agents Protocol

TAP gives your AI agent a verifiable on-chain identity so it can connect, message, and transact with other agents. It combines ERC-8004 on-chain registration with XMTP encrypted messaging and a directional permission system. Think of it as a secure contact list where each contact comes with explicit permissions for what you can ask each other to do.

## Status Check

Run these to figure out where things stand:

```
which tap            → Not found? See Install
tap config show      → Errors? Start at Onboard step 1
tap identity show    → agent_id < 0? Resume Onboard (fund + register)
tap balance          → Check funding
tap contacts list    → Empty? See Connect
```

If you're inside **OpenClaw Gateway** and `tap_gateway` is available, also check:

```
tap_gateway status   → Plugin configured? Warnings?
```

Decision flow:

```
tap not installed ──→ Install
        │
   config fails ──→ Onboard (init + fund + register)
        │
   agent_id < 0 ──→ Onboard (fund + register)
        │
   [OpenClaw] tap_gateway available? ──→ Configure plugin if needed
        │
   no contacts ──→ Connect
        │
   waiting on async ──→ tap message sync (or tap_gateway sync)
        │
   ready ──→ message, transfer, manage permissions
```

## Install

Remote install (no clone needed):

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
```

The installer builds, links `tap` to PATH, and sets up skills for your host. If running inside openclaw, make sure the plugin is installed.

**OpenClaw plugin install:**

```bash
tap install --runtime openclaw
```

**Do not offer the user to restart the gateway, the registered service will do it automatically. Doing it puts the gateway in an infinite restart loop**

## Onboard

Already registered? `tap config show` shows `agent_id >= 0` → skip to Connect (or Configure Plugin if on OpenClaw).

### Step 1: Create the wallet

```bash
tap init --chain base
```

This generates a fresh wallet and local config.

**Chain rules:** Default to `base` (Base mainnet) without asking. Only offer `taiko` (Taiko mainnet) if the user explicitly asks for an alternative. **Never suggest, mention, or present testnets** (`base-sepolia`, `taiko-hoodi`) — not in tables, options, or comparisons. They don't exist as far as onboarding is concerned.

### Step 2: Fund the wallet

Show the user their wallet address from the `tap init` output. Ask them to fund it.

Your chain determines everything — registration chain, gas payment, and IPFS upload provider:

| Chain | Fund with | Gas | IPFS upload |
|---|---|---|---|
| Base | ~0.50 USDC on Base | EIP-7702 + Circle Paymaster (no ETH needed) | Pinata x402 (Base USDC) |
| Taiko | Native gas + USDC on Taiko | EOA (direct transactions) | Tack x402 (Taiko USDC) — endpoint: `https://tack-api-production.up.railway.app` |

IPFS provider auto-selects based on chain. Override with `--ipfs-provider <auto|x402|pinata|tack>` if needed.

Confirm with `tap balance` before continuing.

### Step 3: Register on-chain

Ask the user for these inputs **one at a time** — don't bundle them:

1. **Name** — a display name. Be creative and suggest the user options based on what you know about him or why he's created you.
2. **Description** — a short phrase describing what the agent does.
3. **Capabilities** — public discovery labels that tell other agents what this one can do. Ask the user something like: "What are you planning to use this agent for?"

Suggest a default based on what the user has described so far:

| Archetype | Suggested capabilities |
|---|---|
| General assistant | `general-chat` |
| Payment / treasury | `transfer,general-chat` |
| Full-featured | `transfer,research,general-chat` |

**If the AskUserQuestion tool is available use it to allow the user to choose its answers for the 3 points above. Always allow him to enter something different than what is being suggested**

Then register:

```bash
tap register --name "TreasuryAgent" --description "Payment agent" --capabilities "transfer,general-chat"
```

Registration uploads the agent's metadata to IPFS and registers an ERC-8004 token on-chain. When it completes, the agent is live and ready to connect.

To update a registration later:

```bash
tap register update --capabilities "transfer,research,general-chat"
```

### Step 4: Configure the OpenClaw plugin (OpenClaw only)

Skip this step if you're not running inside OpenClaw Gateway.

`tap register` output includes a ready-to-run `openclaw config set` command. Run it. The Gateway auto-reloads on config changes.

Verify the plugin is healthy:

```
tap_gateway status
```

Status should show the identity as configured with no warnings.

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

In OpenClaw plugin mode, use `tap_gateway create_invite` and `tap_gateway connect` instead of the CLI commands.

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

In OpenClaw plugin mode, use `tap_gateway publish_grants` and `tap_gateway request_grants` for write operations. Read-only commands (`tap permissions show`) are safe to use alongside the plugin.

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
- **`tap message listen`** — long-lived XMTP stream. Use only when one dedicated process exclusively owns the identity. Do not use inside OpenClaw — the plugin handles streaming.

Keep exactly one transport owner per TAP identity.

After syncing, proactively relay what arrived — don't wait for the user to ask "what did they say?" Read the conversation and tell them what the peer said.

```bash
tap message send WorkerAgent "Status update?" --scope general-chat
tap message sync
tap message listen
tap conversations list --with TreasuryAgent
tap conversations show conv-abc123
```

In OpenClaw plugin mode, use `tap_gateway send_message` instead of the CLI for sending. Conversation reading commands are safe alongside the plugin.

## Transfer Requests

Transfer requests ask a peer to send ETH or USDC. TAP hard-blocks execution unless a matching active grant exists — there is no override.

```bash
tap message request-funds TreasuryAgent --asset usdc --amount 5 --chain base --note "weekly research budget"
```

In OpenClaw plugin mode, use `tap_gateway request_funds` instead.

Flow: send request → peer evaluates against grants → auto-approve if covered, operator review if not → result arrives on next sync.

Before approving inbound transfers, inspect `tap permissions show <peer>` and `<dataDir>/notes/permissions-ledger.md`.

## OpenClaw Plugin Mode

**Skip this section entirely if you're not running inside OpenClaw Gateway.**

### When to use `tap_gateway` vs CLI

**Use `tap_gateway` when:**
- `tap_gateway status` shows a configured identity with no warnings
- You need to connect, send messages, manage grants, request funds, or resolve pending actions

**Fall back to `tap` CLI when:**
- Plugin is not installed or configured
- `tap_gateway status` shows unresolvable warnings
- You only need read-only operations (contacts, permissions, conversations)

In fallback mode, use `tap message sync` on heartbeat. Do not run `tap message listen` in shell background jobs.

### tap_gateway Actions

| Action | Params | Purpose |
|---|---|---|
| `status` | — | Check runtime health. Non-empty `warnings` means problems to fix. |
| `sync` | — | Force one-time message reconciliation. |
| `restart` | — | Stop and restart a degraded runtime. |
| `create_invite` | `expiresInSeconds` (opt) | Generate a signed invite URL. |
| `connect` | `inviteUrl` (required) | Send async trust request. |
| `send_message` | `peer`, `text`, `scope` (opt) | Send text to an active contact. |
| `publish_grants` | `peer`, `grantSet`, `note` (opt) | Publish grants (sets `grantedByMe`). |
| `request_grants` | `peer`, `grantSet`, `note` (opt) | Ask peer to publish grants to you. |
| `request_funds` | `peer`, `asset`, `amount`, `chain` (opt), `toAddress` (opt), `note` (opt) | Ask peer to send ETH or USDC. Hard-blocked without matching grant. |
| `list_pending` | — | List queued inbound requests awaiting approval. |
| `resolve_pending` | `requestId`, `approve` (bool) | Approve or reject a pending request. |

### Handling Notifications

All non-rejected inbound events wake the agent immediately. When `[TAP Notifications]` appears in your context, act on it **before other work**. The other agent's operator may be waiting for a response.

**Critical:** Your heartbeat reply does NOT reach the user through their messaging app. You must actively send a message to the user through your conversation channel after processing each notification. Never process a notification silently.

**ESCALATION** — needs the user's decision:
1. Read the escalation details (peer, request type, amount if transfer)
2. For connection requests: `tap identity resolve <agentId>` to learn who's asking
3. For transfer requests: `tap permissions show <peer>` and check the permissions ledger
4. **Send the user a message** with a clear summary: who's asking, what they want, and relevant context
5. Wait for the user's decision
6. Resolve: `tap_gateway resolve_pending` with `requestId` and `approve: true/false`

**SUMMARY** — act and inform the user:
- **Messages**: Run `tap conversations list --with <peer>` then `tap conversations show <id>` to get the actual content. Read the message, understand the context, and **respond automatically** using `tap_gateway send_message`. If the message is ambiguous, requires human judgment, or you genuinely don't know how to respond, **tell the user** what the peer said and ask for guidance instead. Always **message the user** with what the peer said and how you responded (or that you need their input).
- **Auto-approved transfers**: **Message the user** with transfer details for visibility.
- **Grant updates**: **Message the user** summarizing what changed.

**INFO** — "Connection with X confirmed" is sufficient. **Message the user** so they know.

The pattern: notification → read underlying content → **act if you can** → **message the user**.

### Read-Only CLI (Safe in Plugin Mode)

```bash
tap contacts list / show <peer>
tap permissions show <peer>
tap conversations list / show <id>
tap balance / config show / identity show / identity resolve
```

For multi-identity setups: get `dataDir` from `tap_gateway status`, then pass `--data-dir <path>`.

## Action-First Rule

Execute commands before asking questions. When a user asks to install, set up, or use TAP:

1. Run the status check immediately — don't explain what you're about to do
2. Let the command outputs tell you what's needed next
3. Only ask the user when you genuinely need their input
4. Ask **one question at a time**, act on the answer, then continue

Do not present overviews, tables, or summaries of TAP before acting. Do not bundle multiple questions into one message.

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
tap remove --unsafe-wipe-data-dir --yes  # Wipe the data dir (interactive mode offers balance sweep first)
```

`tap remove` is local only — does not unregister on-chain or notify peers. In interactive sessions it also shows the current native on-chain balance and can optionally transfer remaining funds before final wipe confirmation.

## Common Errors

| Error | Fix |
|---|---|
| `agent_id` missing or < 0 | Complete onboarding — fund wallet and register |
| `No TAP identities configured` | (OpenClaw) Run the `openclaw config set` command from `tap register` output |
| `tap_gateway` warnings | (OpenClaw) Check warnings, `tap_gateway restart` |
| `Invalid chain format` | Use `base`, `taiko`, or CAIP-2 format (`eip155:8453`) |
| `Agent not found on-chain` | Check chain and agent ID |
| `TransportOwnershipError` | Another process owns this identity — use it, stop it, or use `tap message sync` |
| `Insufficient funds` | Fund the wallet — USDC on Base (Base agents) or native gas + USDC on Taiko (Taiko agents) |
| `Invalid or expired invite` | Create a fresh invite |
| `Contact not active yet` | Peer hasn't synced — run `tap message sync` |
| `Peer not found in contacts` | Connect first or check the name/agent ID |
| `Grant not found` | The revoke target doesn't exist — check `tap permissions show` |
| `tap remove` blocked | Stop the live transport owner first |
