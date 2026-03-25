# Agents.md

## Purpose
This file is for coding agents working in this repository.
It focuses on implementation reality, not aspirational architecture.
When this file conflicts with code, code wins.

## System Snapshot (As Implemented)
- `tap` is a local-first agent protocol stack with:
	- On-chain identity via ERC-8004 (`tokenId` is `agentId`)
	- Registration metadata in a registration file (`ipfs://...` or `https://...`)
	- Peer messaging over XMTP using JSON-RPC 2.0 payloads
- No backend service exists in this repo.
- Package boundaries:
	- `packages/core`: protocol + storage + transport abstractions
	- `packages/cli`: executable UX and config/bootstrap behavior
	- `packages/openclaw-plugin`: OpenClaw Gateway plugin that owns TAP as a background service
- Dependency direction:
	- `cli -> core`
	- `openclaw-plugin -> core`
	- `core` has no internal workspace dependencies

## Package Responsibilities

### `packages/core`
- Source of truth for protocol and runtime behavior.
- Owns:
	- protocol methods/types
	- identity resolution and registration validation
	- XMTP transport + transport interface
	- trust/contact persistence
	- conversation logging
	- request journal / dedupe / reconciliation state
	- transport owner lock
	- `TapMessagingService`
- If behavior differs between hosts, start by checking whether it should really live here.

### `packages/cli`
- Human/agent-facing `tap` executable.
- Host adapter over `core`, not the source of messaging business logic.
- Owns:
	- command parsing and output formatting
	- CLI-specific prompting / approval UX
	- onboarding commands
	- local operator workflows

### `packages/openclaw-plugin`
- OpenClaw-specific host adapter. **Thin plugin, fat CLI** — see rule below.
- Owns:
	- Gateway plugin manifest/config
	- one long-lived TAP runtime per configured identity inside Gateway
	- periodic reconcile scheduling inside the plugin host
	- the `tap_gateway` tool surface
	- notification pipeline (event classification, queueing, escalation)
	- approval deferral hooks (connection, transfer, scheduling)
- This is the preferred OpenClaw streaming host. OpenClaw shell background jobs are not.

### CLI vs Plugin Boundary (Thin Plugin, Fat CLI)

**Rule: the plugin should only expose actions that require a long-lived transport connection.**

The plugin exists to hold an always-on XMTP transport inside the Gateway process. Its unique capabilities are:
1. Receiving inbound messages in real-time (notification pipeline, event classification, escalation)
2. Deferring and resolving pending approvals (connections, transfers, scheduling)
3. Sending messages/actions through an already-authenticated transport (no cold-start)

Everything else — setup, inspection, on-chain queries, configuration, conversation history — belongs in the CLI because:
- **Single implementation** — no feature parity maintenance across two surfaces
- **Testable in isolation** — CLI commands are pure functions over core; plugin actions require a running Gateway
- **Composable** — CLI works in scripts, CI, other agent runtimes, not just OpenClaw
- **Lower surface area** — fewer plugin actions = fewer bugs in the always-on process

| Belongs in CLI only | Why |
|---|---|
| `init`, `register`, `install`, `remove` | One-time setup, no transport needed |
| `config show/set`, `identity show/resolve` | Read-only inspection, no transport needed |
| `contacts list/show/remove` | Local file reads/writes |
| `conversations list/show` | Local file reads |
| `permissions show/revoke` | Local reads; revoke is rare enough to not warrant plugin duplication |
| `balance` | Pure RPC call, no TAP transport |
| `calendar setup` | One-time OAuth flow |
| `invite create` | Local crypto operation, no transport needed |

| Belongs in plugin | Why |
|---|---|
| `send_message`, `connect` | Uses live transport |
| `request_funds`, `transfer` | Transport + approval pipeline |
| `publish_grants`, `request_grants` | Transport |
| `request_meeting`, `respond_meeting`, `cancel_meeting` | Transport |
| `list_pending`, `resolve_pending` | Acts on live notification pipeline |
| `status`, `sync`, `restart` | Plugin lifecycle |

**Key invariant: the plugin never implements protocol logic that doesn't exist in core.** It is a thin adapter that calls `TapMessagingService` methods. If you keep that discipline, the two surfaces stay in sync by construction rather than by manual feature parity.

When adding a new feature, ask: "Does this need a live XMTP transport?" If no, it goes in the CLI only.

## Skills Layout

There is one unified TAP skill that covers both CLI and OpenClaw plugin mode:

- **Canonical location:** `skills/trusted-agents/SKILL.md` + `references/permissions-v1.md`
- **OpenClaw plugin:** `packages/openclaw-plugin/skills/trusted-agents-openclaw/` receives copies of the canonical files at build time via a `prebuild` script (`cp -r ../../skills/trusted-agents skills/trusted-agents`). The copies are `.gitignored`.
- Both hosts get the same skill content. OpenClaw-specific sections are gated with "Skip this section if you're not running inside OpenClaw Gateway."

Installation expectations:

- OpenClaw plugin install loads the plugin skill directory from `packages/openclaw-plugin/openclaw.plugin.json`, which uses the build-time copied skills.
- `tap install --runtime openclaw` installs the plugin; `tap install --runtime claude` installs the skill for Claude Code. Both point at the same underlying content.
- In this repo, `skills/trusted-agents/` is the single source of truth. The OpenClaw plugin copies and any host-specific installed copies are mirrors.

## Read Order For Fast Orientation
1. `packages/core/src/protocol/*` (wire protocol)
2. `packages/core/src/identity/*` (on-chain + registration resolution)
3. `packages/core/src/transport/interface.ts` then `transport/xmtp.ts`
4. `packages/core/src/trust/*` and `conversation/*` (state persistence)
5. `packages/core/src/runtime/*` (`TapMessagingService`, request journal, transport owner lock)
6. `packages/cli/src/lib/context.ts`, `lib/tap-service.ts`, and `commands/*` (CLI host adapter)
7. `packages/openclaw-plugin/src/*` (Gateway host adapter)

## Core Abstractions To Preserve

### 1) `TransportProvider` (replaceable transport seam)
File: `packages/core/src/transport/interface.ts`
- Contract:
	- `send(peerId, message, options?) -> TransportReceipt`
	- `setHandlers({ onRequest?, onResult? })`
	- `isReachable(peerId)`
	- optional `reconcile(options?)`
	- optional `start/stop`
- Architectural intent: transport is swappable.
- Current implementation: only `XmtpTransport`.

### 2) `IAgentResolver` (identity resolution seam)
File: `packages/core/src/identity/resolver.ts`
- Resolves `agentId + chain -> ResolvedAgent` using:
	- `tokenURI(agentId)` from ERC-8004
	- `ownerOf(agentId)` from ERC-8004
	- fetch + validate registration file
- Has in-memory cache with TTL and max entries.

### 3) `ITrustStore` (connection state seam)
Files: `packages/core/src/trust/trust-store.ts`, `file-trust-store.ts`
- Contact CRUD + lookups by `connectionId`, `(agentId, chain)`, and address.
- `FileTrustStore` is the only implementation, with atomic writes.

### 4) `IConversationLogger` (message log seam)
Files: `packages/core/src/conversation/logger.ts`
- Append/list/get conversation logs and generate markdown transcript.
- Backed by one JSON file per conversation.

### 5) `NotificationAdapter` + `ApprovalHandler` (SDK human-in-loop seam)
Files: `packages/sdk/src/notification.ts`, `approval.ts`
- SDK orchestration defers approvals/notifications to host runtime.

## Protocol And Identity Standards Enforced In Code

### JSON-RPC methods (canonical names)
File: `packages/core/src/protocol/methods.ts`
- `connection/request`
- `connection/result`
- `connection/revoke`
- `permissions/update`
- `message/send`
- `action/request`
- `action/result`

`BOOTSTRAP_METHODS` currently contains only:
- `connection/request`
- `connection/result`

### Registration file invariants
File: `packages/core/src/identity/registration-file.ts`
- Must be type `eip-8004-registration-v1`
- Must include at least one `services` entry named `xmtp`
- `xmtp.endpoint` must be a valid Ethereum address
- Non-XMTP services must use `https:` URLs
- `trustedAgentProtocol.agentAddress` must be a valid Ethereum address
- `xmtp.endpoint` must match `trustedAgentProtocol.agentAddress` (case-insensitive)

### URI safety rules during registration fetch
File: `packages/core/src/identity/registration-file.ts`
- `ipfs://...` is rewritten to `https://ipfs.io/ipfs/...`
- Direct remote URIs must be `https:`
- Local/private network hosts are blocked (`localhost`, `127.x`, RFC1918 ranges, `.local`)
- 10s fetch timeout via `AbortController`

### Chain identifier standard
- Core expects CAIP-2 (`eip155:<chainId>`)
- CLI accepts aliases (`base`, `taiko`, etc.) and normalizes to CAIP-2

## Runtime Composition (Where behavior is decided)

### CLI composition
File: `packages/cli/src/lib/context.ts`
- Builds:
	- `FileTrustStore`
	- `AgentResolver`
	- `FileRequestJournal`
	- `XmtpTransport` (when transport is needed)
- Transport gets resolver injected for bootstrap sender verification.

### SDK composition
File: `packages/sdk/src/orchestrator.ts`
- Reuses the same core abstractions.
- Can use custom `transport` or construct `XmtpTransport` from `xmtp` config.
- `start()` is idempotent with an internal `transportStarted` flag.

## Non-Obvious Behavior You Need To Know

1. One OWS wallet per agent (no raw private key):
- Each agent identity is backed by an Open Wallet Service (OWS) wallet
- A scoped API key authenticates CLI/SDK requests to OWS
- All signing (ERC-8004 ownership, invite signing, XMTP identity) goes through OWS policy-gated signing
- The agent process never sees or stores a raw private key
- Config stores `ows.wallet` (wallet ID) and `ows.api_key` (scoped API key)
- Env overrides: `TAP_OWS_WALLET`, `TAP_OWS_API_KEY`

2. XMTP DB encryption key:
- New agents: derived from `signMessage("xmtp-db-encryption-key")` via OWS, then hashed
- Migrated agents: key computed from the old private key and persisted as `xmtp.db_encryption_key` in config.yaml during migration
- Once persisted, the config value is used directly on subsequent startups

3. Unknown inbound senders are hard-rejected unless bootstrap path passes:
- In `XmtpTransport`, unknown sender can only proceed via `connection/request` or `connection/result`
- Requires `agentResolver` and inbox address verification against resolved `agentAddress`

4. Known senders are still blocked unless contact status is `active`.

5. Trust store lookup by address can throw:
- `findByAgentAddress()` throws if multiple active contacts match same address (+ optional chain)

6. File stores are atomic but process-local locked:
- Uses `AsyncMutex` per instance + `tmp file -> rename`
- No cross-process lock exists
- `TapMessagingService` adds a `.transport.lock` owner file per `dataDir`
- Do not run multiple transport-owning TAP processes against the same agent/data dir at once. If a listener or plugin runtime already owns the identity, other transport-active CLI commands should stop that owner first or use the owner process surface instead.

7. `loadConfig()` requires `agent_id` by default:
- Most commands fail unless `agent_id >= 0`
- `register` explicitly bypasses this with `{ requireAgentId: false }`

8. `init` writes `agent_id: -1` until successful registration updates config.

9. **Config lives inside data-dir** — `--data-dir` (or `TAP_DATA_DIR`) is the single root for all per-agent state:
```
<dataDir>/
├── config.yaml              # agent_id, chain, xmtp.env, ows.wallet, ows.api_key, xmtp.db_encryption_key
├── contacts.json            # Connected peers (trust store)
├── request-journal.json     # Durable TAP action request state
├── pending-connects.json    # Minimal outbound connection state awaiting connection/result
├── ipfs-cache.json          # Content hash → CID (avoids re-upload)
├── conversations/<id>.json  # Per-peer message transcripts
└── xmtp/<inboxId>.db3       # XMTP client DB (encrypted)
```
- Resolution order: `--data-dir` flag > `TAP_DATA_DIR` env > `~/.trustedagents`
- Config resolution: `--config` flag > `<dataDir>/config.yaml`
- This means setting `TAP_DATA_DIR` alone fully isolates an agent (useful for running multiple agents on one machine)

10. Chain support differs between layers:
- Core defaults: Base
- CLI extends chain map with Taiko
- Wallet helper has explicit viem mappings for known chain IDs

11. Register upload path has hidden cache:
- `packages/cli/src/commands/register.ts` stores content-hash cache at `<dataDir>/ipfs-cache.json`
- Cached CID is reused only if `HEAD https://ipfs.io/ipfs/<cid>` succeeds

12. x402 payment is chain-asymmetric:
- Registration tx can be on other chains
- IPFS x402 payment still uses Base mainnet USDC

13. Transfer approval is grant-based:
- `decideTransfer()` in `TapMessagingService` calls `findApplicableTransferGrants()` to check for matching active grants
- If no grants match and an `approveTransfer` hook is registered, the hook decides (can return `null` to leave pending)
- If no grants match and no hook is registered, the request is rejected
- The OpenClaw plugin wires `approveTransfer` to auto-approve when grants cover it and leave pending otherwise
- CLI does not wire `approveTransfer` — no-grant requests are rejected

14. Conversation logging is wired into CLI messaging flows:
- `message send`, `request-funds`, listener processing, and reconciliation append conversation entries
- Conversation commands read the persisted logs from disk

15. Async connection and action outcomes use different durable state:
- `connect` persists a minimal pending-connect record immediately after the transport receipt
- `message listen` and `message sync` process later `connection/result` and `action/result`
- `FileRequestJournal` is the dedupe and reconciliation source for action requests/results
- `pending-connects.json` gates outbound `connection/result` acceptance and survives restarts

16. OpenClaw plugin mode owns transport inside Gateway:
- `packages/openclaw-plugin` starts one `TapMessagingService` per configured TAP identity
- OpenClaw agents should use the `tap_gateway` tool for transport-active operations when the plugin is installed
- `tap message sync` remains the safe fallback when the plugin is not installed
- The plugin wires `emitEvent` to classify inbound messages and push to a per-identity in-memory `TapNotificationQueue`
- Escalation events (connection requests, ungrantable transfers) trigger `requestHeartbeatNow()` + `enqueueSystemEvent()` to wake the agent
- A `before_prompt_build` hook drains the notification queue and injects `[TAP Notifications]` into the agent's context
- Connection requests always defer for user approval via the `approveConnection` hook (returns `null`)
- `resolvePending` handles both `ACTION_REQUEST` and `CONNECTION_REQUEST` entries

17. SDK connect requirement:
- `TrustedAgentsOrchestrator.connect()` returns an explicit error unless `transport` or `xmtp` config is provided

18. Invite chain value is not strongly validated in invite generation:
- `generateInvite()` signs any chain string given by caller
- CAIP-2 correctness is enforced at higher layers, not inside invite generation

## If You Change X, Also Check Y

### Adding/changing a protocol method
- Update `packages/core/src/protocol/methods.ts`
- Decide if it belongs in `BOOTSTRAP_METHODS`
- Update transport request handling logic in `xmtp.ts`
- Update CLI/SDK command callers and tests

### Adding a new chain
- Add to CLI `lib/chains.ts` alias map and `ALL_CHAINS`
- Add viem mapping in CLI `lib/wallet.ts` (or confirm fallback behavior is acceptable)
- Ensure config loading/overrides still produce CAIP-2 keys

### Changing contact or conversation persistence
- Keep atomic write pattern (`tmp + rename`) and strict file modes
- Keep safe path checks for user-derived file components
- Update tests that rely on persistence across instances

### Changing register flow
- Keep registration file invariants aligned with validator
- Keep config auto-update behavior for `agent_id`
- Re-run cache and upload tests (`register`, `ipfs` behavior)

### Changing transport identity checks
- Preserve bootstrap sender verification semantics
- Preserve pending request timeout cleanup to avoid memory leaks
- Validate both unit tests and optional XMTP integration test

### Changing signing or wallet integration
- All signing goes through `SigningProvider` (backed by OWS), never raw private keys
- If adding a new signing operation, wire it through the existing `SigningProvider` from context
- Update OWS wallet provisioning tests if wallet creation flow changes
- Keep `ows.wallet` and `ows.api_key` config fields in sync with env overrides (`TAP_OWS_WALLET`, `TAP_OWS_API_KEY`)

### Adding/changing/removing a CLI command
- Update `skills/trusted-agents/SKILL.md` (the single unified skill). The OpenClaw plugin copies this file at build time, so both hosts update automatically.
- Every CLI command must appear in the skill file as a documented command.
- OpenClaw-specific content (tap_gateway actions, notifications) lives in the "OpenClaw Plugin Mode" section, gated with "Skip this section if you're not running inside OpenClaw Gateway."
- Keep skills concise: command syntax + flags + one example + errors. No internal implementation details.
- The `SKILL.md` must have YAML frontmatter with `name` and `description`
- Commands that perform signing should accept a `SigningProvider` from context, never raw keys

### Changing TAP skill/reference semantics
- The unified skill lives in `skills/trusted-agents/SKILL.md`. The OpenClaw plugin copies skills at build time. Edit only the canonical file at `skills/trusted-agents/`.
- OpenClaw-specific content goes in the "OpenClaw Plugin Mode" section with clear gating ("Skip this section if not OpenClaw").
- If you add OpenClaw-specific behavior, also add the corresponding "In OpenClaw plugin mode, use X instead" note in the relevant command section.

## Build/Test Commands Agents Should Actually Use
```bash
bun install
bun run lint
bun run typecheck
bun run test
# Optional integration:
XMTP_INTEGRATION=true bun run test:xmtp
```
Note: OWS (Open Wallet Service) must be installed and accessible for tests that exercise signing or wallet operations. Tests that mock `SigningProvider` do not require a live OWS instance.

## Deterministic E2E Maintenance
- The GH-safe two-agent CLI flow test lives at `packages/cli/test/e2e-two-agent-flow.test.ts`.
- Update this test whenever there is a meaningful behavioral change to the two-agent flow.
- A change counts as meaningful if it changes any of:
	- protocol method names or payload fields
	- CLI command names, flags, or required sequencing for `invite`, `connect`, `permissions`, `message`, `contacts`, or `conversations`
	- trust/contact persistence shape
	- directional grant schema or ledger schema
	- listener approval behavior or action request/response semantics
	- transfer execution semantics or fake-transfer expectations
	- multi-agent `dataDir` isolation behavior
- A change does **not** count as meaningful if it is only:
	- formatting
	- comments
	- copy-only docs with no behavioral change
	- internal refactors that preserve observable CLI/protocol behavior
- The live XMTP/mainnet smoke runbook is `LIVE_SMOKE_RUNBOOK.md`. Update it when the real-world setup, required secrets, or operational flow changes.

## Repository Conventions Worth Respecting
- ESM only; TypeScript imports use `.js` extension in source.
- Named exports only.
- Biome handles both lint and format.
- TypeScript strictness includes `noUnusedLocals` and `noUnusedParameters`.
