---
name: trusted-agents
description: Operate a Trusted Agents Protocol agent with the `tap` CLI — install, onboard, connect to other agents, manage permissions, send messages, request funds, and schedule meetings. Use this skill whenever the user wants to work with TAP, set up an agent identity, connect agents, exchange grants, schedule meetings or dinners, check calendar availability, or do anything involving agent-to-agent communication or on-chain identity — even if they don't explicitly say "TAP." Also use this skill when the user mentions scheduling, meetings, dinners, calendar setup, or coordinating times with another agent. Also use inside OpenClaw Gateway when the `tap_gateway` tool is available or when handling TAP notifications.
---

# Trusted Agents Protocol

TAP gives your AI agent a verifiable on-chain identity so it can connect, message, and transact with other agents. It combines ERC-8004 on-chain registration with XMTP encrypted messaging and a directional permission system. Think of it as a secure contact list where each contact comes with explicit permissions for what you can ask each other to do.

## Agent-First Rules

- Start with `tap schema` or `tap <command> --describe` when you are unsure about flags, defaults, or response shape.
- Output is TTY-aware: JSON when piped (agents get JSON by default), text when interactive (humans get readable tables). You can force a format with `--output json`, `--output text`, or `--json`/`--plain` flags.
- Add `--select` on list/show commands unless you truly need the full payload.
- Run `--dry-run` before every supported mutation. Dry-run previews include a `scope` field identifying the operation type (e.g. `connection/request`, `transfer/execute`, `permissions/update`, `scheduling/respond`).
- Pipe grant JSON with `--file -` when you are generating the payload dynamically.

Examples:

```bash
tap schema contacts list
tap contacts list --select name,status --limit 10
tap connect "<invite-url>" --dry-run
cat grants.json | tap permissions grant WorkerAgent --file - --dry-run
```

JSON envelope shape: `{ "status": "ok"|"error", "data": ..., "metadata": { "format", "version", ... } }`. Check `status` to distinguish success from failure; error responses include `"error": { "code", "message" }`.

## Status Check

Run these to figure out where things stand (piped output is JSON by default, `--output json` is optional):

```
which tap                                          → Not found? See Install
tap schema                                         → Inspect runtime contract
tap config show --select agent_id,chain            → Errors? Start at Onboard step 1
tap identity show --select agent_id,chain          → agent_id < 0? Resume Onboard (fund + register)
tap balance                                        → Check funding
tap contacts list --select name,status             → Empty? See Connect
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
   ready ──→ message, transfer, schedule meetings, manage permissions
```

## Install

Remote install (no clone needed):

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
```

Stable is the default. To opt into prereleases:

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash -s -- --channel beta
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash -s -- --version 0.2.0-beta.1
```

The installer builds, links `tap` to PATH, and sets up skills for your host. If running inside openclaw, make sure the plugin is installed.

**OpenClaw plugin install:**

```bash
tap install --runtime openclaw
tap install --runtime openclaw --channel beta
tap install --runtime openclaw --version 0.2.0-beta.1
```

**Do not offer the user to restart the gateway, the registered service will do it automatically. Doing it puts the gateway in an infinite restart loop**

## Onboard

Already registered? `tap config show` shows `agent_id >= 0` → skip to Connect (or Configure Plugin if on OpenClaw).

### Step 1: Set up wallet

TAP uses Open Wallet Standard (OWS) for key management — the agent never handles raw private keys. Before running `tap init`, check if the user already has OWS wallets or policies they might want to reuse:

```bash
ows wallet list     # Show existing wallets with addresses
ows policy list     # Show existing policies with chain rules
```

**If wallets exist:** Present them to the user in plain language — wallet name, EVM address, and what chains each wallet is used for. Ask if they want to reuse one for this agent or create a new one. If reusing, pass `--wallet <name>` to `tap init`.

**If no wallets exist** (or user wants a new one): Just run `tap init` — it will create everything.

```bash
# New wallet (default)
tap init --chain base

# Reuse existing wallet
tap init --chain base --wallet my-existing-wallet
```

**If policies exist** that already cover the selected chain: Mention them to the user. `tap init` will detect compatible policies and offer to reuse them.

During `tap init`:
1. OWS is checked (and installed if missing)
2. A new wallet is created (or the specified one is used)
3. A signing policy is created with chain restrictions (or a compatible one is reused)
4. A scoped API key is issued for the agent

Flags: `--wallet <name>` (use existing wallet), `--passphrase <passphrase>` (wallet passphrase), `--non-interactive` (skip prompts, use defaults).

If the user already has an agent with a raw `identity/agent.key` file, use `tap migrate-wallet` instead (see Migration below).

**Chain rules:** Always ask the user what chain they want to use. The two options are `base` and `taiko`. Only mainnet chains are supported.

### Step 2: Fund the wallet

Show the user their wallet address from the `tap init` output. Ask them to fund it.

Your chain determines everything — registration chain, gas payment, and IPFS upload provider:

| Chain | Fund with | Gas | IPFS upload |
|---|---|---|---|
| Base | ~0.50 USDC on Base | EIP-7702 + Circle Paymaster (no ETH needed) | Pinata x402 (Base USDC) |
| Taiko | ~0.50 USDC on Taiko (to the Servo execution account) | EIP-4337 + Servo Paymaster (USDC only, no ETH needed) | Tack x402 (Taiko USDC) — endpoint: `https://tack.taiko.xyz/` |

IPFS provider auto-selects based on chain. Override with `--ipfs-provider <auto|x402|pinata|tack>` if needed.

**Taiko uses a Servo smart account.** When you run `tap init --chain taiko`, the CLI derives a deterministic smart account address from your wallet. This is the **execution account** — the address that holds USDC and executes on-chain transactions. It's deployed automatically on the first transaction via ERC-4337. On Taiko, `tap register` now deploys that execution account before the Tack x402 upload, then continues with the on-chain ERC-8004 registration. Run `tap balance --select messaging_address,execution_address` to see both addresses (`messaging_address` = your EOA, `execution_address` = the Servo smart account). Ask the user to fund the **execution address** with USDC.

If the user chooses Taiko read the full [Servo Agent Skill](https://github.com/ggonzalez94/agent-paymaster/blob/main/skills/servo-agent/SKILL.md). It will help you use the smart account and the paymaster effectively.

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
| Research agent | `research,general-chat` |
| Full-featured | `transfer,research,scheduling,general-chat` |
| Scheduling-capable | `scheduling,general-chat` |

**If the AskUserQuestion tool is available use it to allow the user to choose its answers for the 3 points above. Always allow him to enter something different than what is being suggested**

Then register:

```bash
tap register --name "TreasuryAgent" --description "Payment agent" --capabilities "transfer,general-chat"
```

Registration uploads the agent's metadata to IPFS and registers an ERC-8004 token on-chain. On Taiko, the CLI first deploys the Servo execution account, then pays Tack x402, then submits the ERC-8004 registration. When it completes, the agent is live and ready to connect.

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
tap connect "<invite-url>" --dry-run
tap connect "<invite-url>" --yes --wait 60
tap contacts list
tap contacts show WorkerAgent
tap contacts remove <connectionId>
```

`--wait` polls for the connection to become active (default: 60s). Without it, returns immediately as `pending`.

In OpenClaw plugin mode, use `tap_gateway create_invite` and `tap_gateway connect` instead of the CLI commands.

After establishing connections with a new agent, ask the user if they want to grant permissions and guide him on how to decide.

## Permissions

Connections create trust. **Grants** define what each side is allowed to ask the other to do.

- `grantedByMe` — what the peer may ask **this** agent to do
- `grantedByPeer` — what **this** agent may ask the peer to do
- Capabilities (from registration) are public discovery labels, not permissions
- Grants are the real authorization mechanism

```bash
tap permissions show WorkerAgent
tap permissions grant WorkerAgent --file ./grants.json --note "weekly payment policy" --dry-run
cat ./request.json | tap permissions request TreasuryAgent --file - --note "need weekly budget" --dry-run
tap permissions revoke WorkerAgent --grant-id worker-weekly-usdc --note "budget paused" --dry-run
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

**Scheduling (weekdays only):**
```json
[{
  "grantId": "peer-scheduling",
  "scope": "scheduling/request",
  "constraints": {
    "maxDurationMinutes": 120,
    "allowedDays": ["mon", "tue", "wed", "thu", "fri"],
    "allowedTimeRange": { "start": "09:00", "end": "18:00" },
    "timezone": "America/New_York"
  }
}]
```

**Scheduling (open):**
```json
[{ "grantId": "peer-scheduling-open", "scope": "scheduling/request" }]
```

See `references/permissions-v1.md` for the full JSON spec with all fields and additional templates.

| Scope | Purpose |
|---|---|
| `general-chat` | Conversational exchange |
| `research` | Questions, information gathering |
| `scheduling/request` | Meeting scheduling — propose, counter, accept, reject, cancel |
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
tap conversations list --with TreasuryAgent --select id,peer,last_message
tap conversations show conv-abc123
```

In OpenClaw plugin mode, use `tap_gateway send_message` instead of the CLI for sending. Conversation reading commands are safe alongside the plugin.

## Transfer Requests

Transfer requests ask a peer to send ETH or USDC. If an existing grant exists that covers the amount, the transfer can happen automatically, if not it **MUST ALWAYS BE SURFACED TO THE USER FOR APPROVAL**.
When showing the human transfer requests or summaries always show the reason if it exists.

```bash
tap message request-funds TreasuryAgent --asset usdc --amount 5 --chain base --note "weekly research budget" --dry-run
```

In OpenClaw plugin mode, use `tap_gateway request_funds` instead.

Flow: send request → peer evaluates against grants → auto-approve if covered, operator review if not → result arrives on next sync.

Before approving inbound transfers, inspect `tap permissions show <peer>` and `<dataDir>/notes/permissions-ledger.md`.

## Direct Transfers

Direct transfers send funds from the local agent wallet to any EVM address (no peer request, no XMTP).

```bash
tap transfer --to <address> --asset <native|usdc> --amount <amount> [--chain <chain>] [--dry-run] [--yes]
```

Example:

```bash
tap transfer --to 0x1111111111111111111111111111111111111111 --asset usdc --amount 5 --chain base
```

Validation errors:
- invalid `--to` address
- invalid/non-positive `--amount`
- unsupported `--asset` (must be `native` or `usdc`)
- unknown chain or `usdc` on a chain without a configured USDC token

In OpenClaw plugin mode, use `tap_gateway transfer` with `asset`, `amount`, `toAddress`, and optionally `chain` (defaults to configured chain, must be CAIP-2).

## Meeting Scheduling

Schedule meetings with connected peers. Agents negotiate times autonomously (checking calendars, finding overlapping availability, counter-proposing), but always ask the human for final confirmation before accepting.

### Setup calendar (optional but recommended)

```bash
tap calendar setup --provider google    # Walk through Google Calendar auth
tap calendar check                      # Verify connection works
```

Without a calendar provider, scheduling still works — you just respond to proposals manually instead of the agent auto-checking availability.

### Request a meeting

```bash
tap message request-meeting BobAgent --title "Dinner" --duration 90 --preferred "2026-03-28T19:00:00Z" --note "That Italian place?" --dry-run
```

- `--preferred` is optional. If set and a calendar is configured, the agent checks availability around that time and proposes the best free slots.
- If no preferred time or no calendar, the preferred time becomes the single proposed slot.
- Returns a `schedulingId` you use to track this negotiation.

### Respond to a proposal

```bash
tap message respond-meeting sch_abc123 --accept --dry-run
tap message respond-meeting sch_abc123 --reject --reason "Busy that week" --dry-run
```

When your agent has a calendar configured and a scheduling grant covers the request, it auto-negotiates (checks your calendar, counters if no overlap) and surfaces the best matching slot for your approval. You just confirm with `--accept`.

### Cancel a confirmed meeting

```bash
tap message cancel-meeting sch_abc123 --reason "Something came up" --dry-run
```

Sends cancellation to the peer and removes the event from your calendar.

### How negotiation works

1. Alice's agent checks her calendar, sends a proposal with ranked time slots
2. Bob's agent checks Bob's calendar against the proposal:
   - **Overlap found** → surfaces the best slot for Bob's approval
   - **No overlap** → auto-counters with Bob's available slots
   - **No calendar** → defers to Bob for manual decision
3. When agents converge on a slot, both humans confirm
4. Calendar events are created on both sides

Grants authorize auto-negotiation (the agent handles the back-and-forth), not auto-acceptance — the human always confirms the final booking. Without a grant, every inbound proposal is surfaced for manual decision.

### Scheduling grant constraints

| Constraint | Type | Purpose |
|---|---|---|
| `maxDurationMinutes` | number | Reject proposals longer than this |
| `allowedDays` | string[] | Allowed days: `["mon","tue","wed","thu","fri"]` |
| `allowedTimeRange` | `{ start, end }` | Business hours in local time, e.g., `"09:00"` to `"18:00"` |
| `timezone` | string | IANA timezone for interpreting day/time constraints |

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
| `send_message` | `peer`, `text`, `scope` (opt), `autoGenerated` (opt, bool) | Send text to an active contact. Set `autoGenerated=true` for auto-replies to prevent loops. |
| `publish_grants` | `peer`, `grantSet`, `note` (opt) | Publish grants (sets `grantedByMe`). |
| `request_grants` | `peer`, `grantSet`, `note` (opt) | Ask peer to publish grants to you. |
| `request_funds` | `peer`, `asset`, `amount`, `chain` (opt), `toAddress` (opt), `note` (opt) | Ask peer to send ETH or USDC. Hard-blocked without matching grant. |
| `transfer` | `asset`, `amount`, `toAddress`, `chain` (opt) | Execute an on-chain transfer directly from the agent wallet. Requires live signing provider. |
| `request_meeting` | `peer`, `title`, `duration` (opt), `preferred` (opt), `location` (opt), `note` (opt) | Propose a meeting with a connected peer. |
| `respond_meeting` | `schedulingId`, `meetingAction` (`accept`/`reject`), `reason` (opt) | Accept or reject a scheduling proposal. |
| `cancel_meeting` | `schedulingId`, `reason` (opt) | Cancel a confirmed meeting. |
| `list_pending` | — | List queued inbound requests awaiting approval. |
| `resolve_pending` | `requestId`, `approve` (bool) | Approve or reject a pending request. |

### Handling Notifications

All non-rejected inbound events wake the agent immediately. When `[TAP Notifications]` appears in your context, act on it **before other work**. The other agent's operator may be waiting for a response.

**Critical:** Your heartbeat reply does NOT reach the user through their messaging app. You must actively send a message to the user through your conversation channel after processing each notification. Never process a notification silently.

**ESCALATION** — needs the user's decision:
1. Read the escalation details (peer, request type, amount if transfer, proposed times if scheduling)
2. For connection requests: `tap identity resolve <agentId>` to learn who's asking
3. For transfer requests: `tap permissions show <peer>` and check the permissions ledger
4. For scheduling proposals: show the proposed times in the user's timezone, the meeting title, and who's asking
5. **Send the user a message** with a clear summary: who's asking, what they want, and relevant context
6. Wait for the user's decision
7. Resolve: `tap_gateway resolve_pending` with `requestId` and `approve: true/false`, or use `tap_gateway respond_meeting` for scheduling

**AUTO-REPLY** — an active contact sent you a message that needs a reply:
1. Read the peer's message from the notification text
2. Optionally check conversation history with `tap conversations list --with <peer>` then `tap conversations show <id>` for context
3. Reply using `tap_gateway send_message` with `autoGenerated: true`
4. Summarize to the user what the peer said and what you replied, **in a single message. Do NOT send the user two separate messages (one for receiving, one for replying).**

**SUMMARY** — act and inform the user:
- **Auto-reply from peer**: Report the auto-reply content to the user. Do NOT reply back — this is an auto-generated response, not a new conversation from a human.
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

When you need to explore the interface, prefer:

```bash
tap schema
tap <command> --describe
```

```bash
tap balance [chain]                    # ETH + USDC balances
tap config show                        # Resolved config (secrets redacted)
tap config set <key> <value>           # Update one config value
tap identity show                      # Wallet address, agent ID, chain
tap identity resolve <id> [chain]      # Look up another agent
tap identity resolve-self              # Check own published registration
tap schema [command...]                # Machine-readable CLI schema
tap install                            # Auto-detect host
tap install --runtime claude           # Claude Code skill install
tap install --runtime openclaw         # OpenClaw plugin install
tap migrate-wallet                     # Migrate legacy agent.key to OWS
tap remove --dry-run                   # Preview what would be deleted
tap remove --unsafe-wipe-data-dir --yes  # Wipe the data dir (interactive mode offers balance sweep first)
```

`tap remove` is local only — does not unregister on-chain or notify peers. In interactive sessions it also shows the current native on-chain balance and can optionally transfer remaining funds before final wipe confirmation.

## Migration (Legacy Key → OWS)

If an agent was created before OWS integration and has a raw `identity/agent.key` file:

```bash
tap migrate-wallet
```

This command:
1. Reads the existing private key from `identity/agent.key`
2. Preserves the XMTP database encryption key (computed from the old key and saved to config)
3. Imports the key into an OWS wallet
4. Creates a signing policy and scoped API key
5. Verifies the OWS wallet address matches the original
6. Updates `config.yaml` with the `ows` block
7. Deletes `identity/agent.key`

Flags: `--passphrase <passphrase>` (wallet passphrase for OWS import), `--non-interactive` (skip prompts).

The agent keeps its on-chain identity, contacts, and conversation history — only the key storage changes.

## TAP Apps

TAP apps extend agent capabilities with installable action handlers (e.g., transfer, scheduling). Apps are installed per-agent and store their state inside the agent's data directory under `apps/<name>/`.

```bash
tap app install <name>     # Install a TAP app from npm
tap app remove <name>      # Remove a TAP app
tap app list               # List installed apps
```

Examples:

```bash
tap app list
tap app install @trustedagents/app-transfer
tap app remove @trustedagents/app-scheduling
```

Transfer, scheduling, and permission-request handling are built into the TAP runtime today. `tap app install` is for additional third-party TAP apps published to npm.

## Common Errors

| Error | Fix |
|---|---|
| `agent_id` missing or < 0 | Complete onboarding — fund wallet and register |
| `No TAP identities configured` | (OpenClaw) Run the `openclaw config set` command from `tap register` output |
| `tap_gateway` warnings | (OpenClaw) Check warnings, `tap_gateway restart` |
| `Invalid chain format` | Use `base`, `taiko`, or CAIP-2 format (`eip155:8453`) |
| `Agent not found on-chain` | Check chain and agent ID |
| `TransportOwnershipError` | Another process owns this identity — use it, stop it, or use `tap message sync` |
| `Insufficient funds` | Fund the wallet — USDC on Base (Base agents) or USDC to the Servo execution account on Taiko (Taiko agents, run `tap balance --select messaging_address,execution_address` for the address) |
| `Invalid or expired invite` | Create a fresh invite |
| `Contact not active yet` | Peer hasn't synced — run `tap message sync` |
| `Peer not found in contacts` | Connect first or check the name/agent ID |
| `Grant not found` | The revoke target doesn't exist — check `tap permissions show` |
| `tap remove` blocked | Stop the live transport owner first |
| `No calendar provider configured` | Run `tap calendar setup --provider google` |
| `Google Workspace CLI (gws) is not installed` | Install with `npm install -g @googleworkspace/cli` |
| `No matching scheduling grant` | Peer needs to publish a `scheduling/request` grant to you |
| `OWS not installed` | Install with `curl -fsSL https://docs.openwallet.sh/install.sh \| bash` |
| `ows.wallet is required` | Run `tap init` to set up an OWS wallet, or `tap migrate-wallet` if you have a legacy key |
| `ows.apiKey must start with ows_key_` | The API key in config is invalid — re-run `tap init` or create a new key with `ows key create` |
| `Address mismatch after OWS import` | The OWS wallet derived a different address — check the wallet or try importing again |
