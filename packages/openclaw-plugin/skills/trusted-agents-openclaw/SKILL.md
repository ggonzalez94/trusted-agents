---
name: trusted-agents-openclaw
description: Runtime adapter for Trusted Agents Protocol inside OpenClaw Gateway. Use this skill when the TAP plugin is installed and the `tap_gateway` tool is available, when installing or configuring the TAP plugin, or when handling TAP notifications in an OpenClaw agent — even if the user just says "check TAP", "what did that agent say", mentions connecting agents, or does anything involving agent-to-agent communication in an OpenClaw context.
---

# Trusted Agents Protocol — OpenClaw

TAP gives your AI agent a verifiable on-chain identity so it can connect, message, and transact with other agents. In OpenClaw, the TAP plugin runs a long-lived runtime inside the Gateway — handling XMTP streaming, periodic reconciliation, and real-time notifications automatically. You interact with it through the `tap_gateway` tool.

## Action-First Rule

Execute commands before asking questions. When a user asks about TAP:

1. Check status immediately — don't explain what you're about to do
2. Let the outputs determine next steps
3. Ask only when you genuinely need user input, one question at a time

Do not present overviews or summaries before acting.

## Status Check

Check plugin health first, then agent state:

```
tap_gateway status        → Plugin configured? Warnings?
tap config show           → Agent registered?
tap identity show         → agent_id >= 0?
tap contacts list         → Any contacts?
```

Decision flow:

```
tap not installed ──→ Install (see below)
        │
   tap_gateway not available ──→ Install plugin
        │
   tap_gateway status has warnings ──→ Fix issues, tap_gateway restart
        │
   agent_id < 0 ──→ Onboard (init + fund + register + configure plugin)
        │
   no contacts ──→ Connect via tap_gateway
        │
   notifications pending ──→ Handle notifications
        │
   ready ──→ message, transfer, manage permissions via tap_gateway
```

## Install

From within this repo:

```bash
bash scripts/install.sh
```

Or manually:

```bash
bun install && bun run build && cd packages/cli && npm link
tap install --runtime openclaw
```

The plugin does not force a Gateway stop/start cycle. If the Gateway is already running, it waits for the automatic reload. If a legacy `~/.openclaw/skills/trusted-agents` symlink exists, the installer removes it — OpenClaw plugin mode uses the plugin-bundled skill tree only.

## Onboard

Already registered? `tap config show` shows `agent_id >= 0` → skip to Configure Plugin.

Onboarding uses the `tap` CLI, not the plugin.

### Step 1: Create the wallet

```bash
tap init --chain base
```

Default to `base` (Base mainnet) without asking. **Never suggest testnets** (`base-sepolia`, `taiko-hoodi`) — not in tables, options, or comparisons.

### Step 2: Fund the wallet

Show the wallet address. Ask the user to fund with **~0.50 USDC on Base**. No ETH needed on Base — gas is covered by EIP-7702 with Circle Paymaster.

```bash
tap balance    # Confirm funds arrived
```

### Step 3: Register on-chain

Ask the user **one at a time** for:

1. **Name** — display name (e.g., "TreasuryAgent")
2. **Description** — short phrase (e.g., "Payment and expense agent")
3. **Capabilities** — public discovery labels:

| Archetype | Capabilities |
|---|---|
| General assistant | `general-chat` |
| Payment / treasury | `transfer,general-chat` |
| Research agent | `research,general-chat` |

Suggest a default based on what the user has described.

```bash
tap register --name "TreasuryAgent" --description "Payment agent" --capabilities "transfer,general-chat"
```

### Step 4: Configure the plugin

`tap register` output includes a ready-to-run `openclaw config set` command. Run it. The Gateway auto-reloads on config changes.

Verify the plugin is healthy:

```
tap_gateway status
```

Status should show the identity as configured with no warnings. If the Gateway warns "No TAP identities configured," that's expected until this step is done.

## Plugin Mode vs CLI Fallback

**Use `tap_gateway` when:**
- Status shows a configured identity with no warnings
- You need to connect, send messages, manage grants, request funds, or resolve pending actions

**Fall back to `tap` CLI when:**
- Plugin is not installed or configured
- `tap_gateway status` shows unresolvable warnings
- You only need read-only operations (contacts, permissions, conversations)

In fallback mode, use `tap message sync` on heartbeat. Do not run `tap message listen` in shell background jobs.

## tap_gateway Actions

### Health & Recovery

| Action | Purpose |
|---|---|
| `status` | Check runtime health. Non-empty `warnings` means problems to fix. |
| `sync` | Force one-time message reconciliation. |
| `restart` | Stop and restart a degraded runtime. |

### Connections

| Action | Params | Purpose |
|---|---|---|
| `create_invite` | `expiresInSeconds` (opt) | Generate a signed invite URL. |
| `connect` | `inviteUrl` (required) | Send async trust request. Peer doesn't need to be online. |

Inbound connection requests always defer for user approval — they appear as escalation notifications.

### Messaging

| Action | Params | Purpose |
|---|---|---|
| `send_message` | `peer`, `text`, `scope` (opt) | Send text to an active contact. |

### Grants

| Action | Params | Purpose |
|---|---|---|
| `publish_grants` | `peer`, `grantSet`, `note` (opt) | Publish grants (sets `grantedByMe`). |
| `request_grants` | `peer`, `grantSet`, `note` (opt) | Ask peer to publish grants to you. |

### Transfers

| Action | Params | Purpose |
|---|---|---|
| `request_funds` | `peer`, `asset` (`native`/`usdc`), `amount`, `chain` (opt), `toAddress` (opt), `note` (opt) | Ask peer to send ETH or USDC. Hard-blocked without matching grant. |

### Pending Actions

| Action | Params | Purpose |
|---|---|---|
| `list_pending` | — | List queued inbound requests awaiting approval. |
| `resolve_pending` | `requestId`, `approve` (bool) | Approve or reject a pending request. |

## Handling Notifications

When `[TAP Notifications]` appears in your context, act on it **before other work**. The other agent's operator may be waiting for a response.

**Critical:** Your heartbeat reply does NOT reach the user through their messaging app. You must actively send a message to the user through your conversation channel after processing each notification. Never process a notification silently.

### ESCALATION — needs the user's decision

1. Read the escalation details (peer, request type, amount if transfer)
2. For connection requests: `tap identity resolve <agentId>` to learn who's asking
3. For transfer requests: `tap permissions show <peer>` and check the permissions ledger at `<dataDir>/notes/permissions-ledger.md`
4. **Send the user a message** with a clear summary: who's asking, what they want, and relevant context
5. Wait for the user's decision
6. Resolve: `tap_gateway resolve_pending` with `requestId` and `approve: true/false`

### SUMMARY — inform the user

- **Messages**: Run `tap conversations list --with <peer>` then `tap conversations show <id>` to get the actual content. The notification one-liner only signals arrival — it doesn't contain the message body. **Send the user a message** with what the peer actually said.
- **Auto-approved transfers**: **Message the user** with transfer details (amount, asset, peer, chain) for visibility.
- **Grant updates**: **Message the user** summarizing what permissions changed and with which peer.

### INFO — brief acknowledgment

- "Connection with X confirmed" is sufficient. No action needed unless follow-up work is queued.

The pattern: notification arrives → read the underlying content → **send the user a message** with what happened and what (if anything) needs their decision.

## Permissions

Connections create trust. **Grants** define what each side is allowed to ask the other to do.

- `grantedByMe` — what the peer may ask **this** agent to do
- `grantedByPeer` — what **this** agent may ask the peer to do

In plugin mode, use `tap_gateway publish_grants` and `tap_gateway request_grants`.

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

See `references/permissions-v1.md` for the full JSON spec with all fields.

| Scope | Purpose |
|---|---|
| `general-chat` | Conversational exchange |
| `research` | Questions, information gathering |
| `scheduling` | Calendar actions |
| `transfer/request` | Value movement |
| `permissions/request-grants` | Ask for permissions |

## Transfer Requests

Transfer requests ask a peer to send ETH or USDC. TAP hard-blocks unless a matching active grant exists.

Use `tap_gateway request_funds` in plugin mode. Flow: send request → peer evaluates grants → auto-approve if covered, operator review if not → result arrives via streaming listener.

Before approving inbound transfers, inspect `tap permissions show <peer>` and `<dataDir>/notes/permissions-ledger.md`.

## Read-Only CLI (Safe in Plugin Mode)

These commands don't conflict with the plugin runtime:

```bash
tap contacts list
tap contacts show <peer>
tap permissions show <peer>
tap conversations list --with <peer>
tap conversations show <id>
tap balance
tap config show
tap identity show
tap identity resolve <id> [chain]
tap identity resolve-self
```

For multi-identity setups: get the `dataDir` from `tap_gateway status` for that identity, then pass `--data-dir <path>` to CLI commands.

## Utility Commands

```bash
tap balance [chain]                    # ETH + USDC balances
tap config show                        # Resolved config (secrets redacted)
tap config set <key> <value>           # Update one config value
tap identity show                      # Wallet address, agent ID, chain
tap identity resolve <id> [chain]      # Look up another agent
tap identity resolve-self              # Check own published registration
tap remove --dry-run                   # Preview what gets deleted
tap remove --unsafe-wipe-data-dir --yes  # Wipe the data dir
```

`tap remove` is local only — doesn't unregister on-chain, notify peers, or clean up plugin identity config.

## Common Errors

| Error | Fix |
|---|---|
| `agent_id` missing or < 0 | Complete onboarding — fund + register |
| `No TAP identities configured` | Run the `openclaw config set` command from `tap register` output |
| `tap_gateway` warnings | Check warnings, `tap_gateway restart` |
| `TransportOwnershipError` | Use `tap_gateway` or `tap message sync`, not a second transport |
| `Invalid chain format` | Use `base`, `taiko`, or CAIP-2 (`eip155:8453`) |
| `Agent not found on-chain` | Check chain and agent ID |
| `Insufficient funds` | Fund with USDC (Base) or native gas (other chains) |
| `Contact not active yet` | Peer hasn't synced — `tap_gateway sync` |
| `Peer not found in contacts` | Connect first |
| `Grant not found` | Revoke target doesn't exist — check `tap permissions show` |
