# E2E Live Testing Design

## Purpose

Automated end-to-end tests that exercise the full TAP user journey against real infrastructure (XMTP, OWS, ERC-8004 on-chain registry, USDC transfers) on Base mainnet and Taiko mainnet. These tests gate every npm release, ensuring core user-facing scenarios work before publishing.

## Goals

- Catch integration regressions that mocked tests miss (XMTP delivery, OWS signing, on-chain registration, AA gas sponsorship, real USDC transfers)
- Run automatically as a release gate and on-demand via manual trigger
- Cost ~$1-2 per release (USDC for registration + micro-transfers, no ETH needed thanks to AA)
- Be maintainable: one canonical scenario list shared between real and mocked E2E test files

## Non-Goals

- Performance/load testing
- Concurrent-operation testing (single-listener-per-identity is enforced by design)
- Calendar/meeting scheduling (deferred — requires Google Calendar OAuth)
- Testing the OpenClaw plugin (plugin has its own test suite; this tests CLI + core)

## Architecture

### Two E2E test files, one scenario source

```
packages/cli/test/e2e/
  scenarios.ts          Shared scenario metadata
  helpers.ts            Shared assertion/polling utilities
  e2e-live.test.ts      Real E2E: hits mainnet, real XMTP, real OWS
  e2e-mock.test.ts      Mocked E2E: loopback transport, static resolver
```

Both files cover the same scenarios in the same order. They differ only in setup (real vs mocked infrastructure) and message delivery mechanics (poll-based sync vs instant loopback).

The real E2E is the source of truth for "what scenarios we cover." The mocked E2E mirrors it for fast CI feedback on every PR.

### Scenario execution model

- Tests are sequential within a phase (each step depends on the previous)
- Phases are sequential (connection before grants, grants before transfers)
- Message delivery uses poll-based `tap message sync` with retry + timeout
- No background listener processes — sync-based flow only

### Chain parallelism

Base and Taiko run as separate GitHub Actions jobs (matrix strategy). Each job is self-contained: creates fresh agents, registers, runs all scenarios, reports independently.

## Wallet & Secrets

### OWS wallet setup

Two long-lived OWS wallets: `e2e-agent-a` and `e2e-agent-b`. Each wallet has:
- A policy allowing both `eip155:8453` (Base) and `eip155:167000` (Taiko)
- A scoped API key bound to that policy

The same wallet is used on both chains. Each release creates fresh agent IDs (new `tap init` + `tap register`) but reuses the same wallet addresses and USDC balances.

### GitHub Actions secrets

| Secret | Description |
|---|---|
| `E2E_AGENT_A_OWS_WALLET` | Agent A wallet name |
| `E2E_AGENT_A_OWS_API_KEY` | Agent A scoped API key (passphrase for OWS signing) |
| `E2E_AGENT_B_OWS_WALLET` | Agent B wallet name |
| `E2E_AGENT_B_OWS_API_KEY` | Agent B scoped API key |
| `NPM_TOKEN` | Existing — npm publish |

### Balance guard

Phase 0 (preflight) checks USDC balance on both agents, both chains. If any balance is below a threshold (0.50 USDC), the test fails immediately with a funding message:

```
E2E ABORT: Agent A on eip155:8453 has 0.12 USDC.
Minimum required: 0.50 USDC.
Fund address 0xABC... on Base with USDC to continue.
```

### Gas handling

No ETH required. All transactions use Account Abstraction:
- Base: EIP-7702 with Circle paymaster
- Taiko: EIP-4337 with paymaster

The AA configuration is set during `tap init` per chain and stored in config.yaml.

## Test Scenarios

All scenarios run per-chain. Each chain gets a fresh pair of agents.

### Phase 0: Preflight

| # | Scenario | Assertions |
|---|---|---|
| 0.1 | Validate OWS wallet secrets from env | Env vars present and non-empty |

### Phase 1: Onboarding & Identity

| # | Scenario | Assertions |
|---|---|---|
| 1.1 | `tap init` Agent A with OWS wallet | Exit 0. config.yaml has `agent_id: -1`, correct `ows.wallet`, correct chain |
| 1.2 | `tap init` Agent B with OWS wallet | Same as 1.1 |
| 1.3 | Check USDC balance (Agent A) via `tap balance` or RPC | Balance >= 0.50 USDC. If below, fail with funding address and instructions |
| 1.4 | Check USDC balance (Agent B) | Same as 1.3 |
| 1.5 | `tap register` Agent A (IPFS upload + on-chain mint) | Exit 0. `tokenURI(agentId)` returns IPFS URI. `ownerOf(agentId)` returns Agent A's address |
| 1.6 | `tap register` Agent B | Same as 1.5 |
| 1.7 | `tap identity resolve` Agent A | Exit 0. Output shows correct name, address, XMTP endpoint |
| 1.8 | `tap identity resolve` Agent B | Same as 1.7 |

### Phase 2: Connection & Trust

| # | Scenario | Assertions |
|---|---|---|
| 2.1 | `tap invite create` (Agent A) | Exit 0. Output contains invite payload |
| 2.2 | `tap connect` (Agent B accepts Agent A's invite) | Exit 0. Connection request sent over XMTP |
| 2.3 | `tap message sync` (Agent A) | Receives `connection/request` from Agent B. Processes and sends `connection/result` |
| 2.4 | `tap message sync` (Agent B) | Receives `connection/result`. Agent B's contacts show Agent A as `active` |
| 2.5 | `tap contacts list` (Agent A) | Shows Agent B as `active` contact |
| 2.6 | `tap contacts list` (Agent B) | Shows Agent A as `active` contact |

### Phase 3: Permissions & Grants

| # | Scenario | Assertions |
|---|---|---|
| 3.1 | `tap permissions show` (Agent B, before any grants) | Exit 0. No active grants |
| 3.2 | `tap permissions grant` (Agent A grants Agent B transfer permission: `{ asset: "usdc", chain: "<caip2>", maxAmount: "0.01" }`) | Exit 0 |
| 3.3 | `tap message sync` (Agent B) | Receives `permissions/update` |
| 3.4 | `tap permissions show` (Agent B) | Shows active grant with correct asset, chain, maxAmount |

### Phase 4: Messaging

| # | Scenario | Assertions |
|---|---|---|
| 4.1 | `tap message send` (Agent A to Agent B: "ping from A") | Exit 0 |
| 4.2 | `tap message sync` (Agent B) | Receives message containing "ping from A" |
| 4.3 | `tap message send` (Agent B to Agent A: "pong from B") | Exit 0 |
| 4.4 | `tap message sync` (Agent A) | Receives message containing "pong from B" |
| 4.5 | `tap conversations show` (Agent A) | Contains both messages |
| 4.6 | `tap conversations show` (Agent B) | Contains both messages |

### Phase 5: Transfers

| # | Scenario | Assertions |
|---|---|---|
| 5.1 | Record Agent B's USDC balance (before) | Store balance for delta comparison |
| 5.2 | `tap request-funds` (Agent B requests 0.001 USDC from Agent A) | Exit 0. Request sent over XMTP |
| 5.3 | `tap message sync` (Agent A) | Grant matches request. `decideTransfer()` auto-approves. `executeTransfer` runs real USDC transfer. Returns tx hash |
| 5.4 | `tap message sync` (Agent B) | Receives `action/result` with status "completed" and tx hash |
| 5.5 | Verify Agent B's USDC balance | Balance increased by 0.001 USDC (with tolerance for potential fee precision) |
| 5.6 | `tap permissions revoke` (Agent A revokes the grant) | Exit 0. Grant status is `revoked` in ledger |
| 5.7 | `tap message sync` (Agent B) | Receives `permissions/update` with revocation |
| 5.8 | `tap request-funds` (Agent B requests 0.001 USDC from Agent A) | Exit 0. Request sent |
| 5.9 | `tap message sync` (Agent A) | No matching grant. `decideTransfer()` returns false. Auto-rejects |
| 5.10 | `tap message sync` (Agent B) | Receives `action/result` with status "rejected" |
| 5.11 | Verify Agent B's USDC balance unchanged | Same as post-transfer balance from 5.5 |

## CI Integration

### Release workflow (`release.yml`)

```yaml
on:
  push:
    tags: ["v*"]
  workflow_dispatch:
    inputs:
      skip_publish:
        description: "Run E2E only, skip npm publish"
        type: boolean
        default: true

jobs:
  validate-version:
    # Existing version validation (skip on workflow_dispatch)

  e2e:
    needs: [validate-version]
    strategy:
      fail-fast: false
      matrix:
        chain: [base, taiko]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: e2e
    steps:
      - checkout
      - setup bun
      - bun install --frozen-lockfile
      - bun run build
      - run e2e-live.test.ts with:
          E2E_CHAIN=${{ matrix.chain }}
          E2E_AGENT_A_OWS_WALLET=${{ secrets.E2E_AGENT_A_OWS_WALLET }}
          E2E_AGENT_A_OWS_API_KEY=${{ secrets.E2E_AGENT_A_OWS_API_KEY }}
          E2E_AGENT_B_OWS_WALLET=${{ secrets.E2E_AGENT_B_OWS_WALLET }}
          E2E_AGENT_B_OWS_API_KEY=${{ secrets.E2E_AGENT_B_OWS_API_KEY }}

  publish:
    needs: [e2e]
    if: startsWith(github.ref, 'refs/tags/v') && inputs.skip_publish != true
    # Existing publish steps
```

`fail-fast: false` ensures both chain jobs run even if one fails — useful for diagnosing chain-specific issues.

### PR workflow (`ci.yml`)

No changes to triggers. The `test` job runs the mocked E2E (`e2e-mock.test.ts`) as part of the normal vitest suite. Same speed, same cost (zero), same determinism.

## Shared Test Utilities

### `scenarios.ts`

Exports scenario metadata shared between real and mocked E2E:

```typescript
export const SCENARIOS = {
  // Phase 0
  PREFLIGHT_BALANCE_A: { name: "Check Agent A USDC balance", phase: 0 },
  PREFLIGHT_BALANCE_B: { name: "Check Agent B USDC balance", phase: 0 },

  // Phase 1
  INIT_AGENT_A: { name: "Init Agent A from OWS wallet", phase: 1 },
  INIT_AGENT_B: { name: "Init Agent B from OWS wallet", phase: 1 },
  REGISTER_AGENT_A: { name: "Register Agent A (IPFS + on-chain)", phase: 1 },
  REGISTER_AGENT_B: { name: "Register Agent B (IPFS + on-chain)", phase: 1 },
  RESOLVE_AGENT_A: { name: "Resolve Agent A identity", phase: 1 },
  RESOLVE_AGENT_B: { name: "Resolve Agent B identity", phase: 1 },

  // Phase 2
  CREATE_INVITE: { name: "Create invite (Agent A)", phase: 2 },
  ACCEPT_INVITE: { name: "Accept invite and connect (Agent B)", phase: 2 },
  SYNC_CONNECTION_REQUEST: { name: "Sync connection request (Agent A)", phase: 2 },
  SYNC_CONNECTION_RESULT: { name: "Sync connection result (Agent B)", phase: 2 },
  VERIFY_CONTACTS: { name: "Verify bidirectional active contacts", phase: 2 },

  // Phase 3
  VERIFY_NO_GRANTS: { name: "Verify no grants before granting", phase: 3 },
  GRANT_TRANSFER: { name: "Grant USDC transfer permission", phase: 3 },
  SYNC_GRANT: { name: "Sync grant to grantee", phase: 3 },
  VERIFY_GRANT: { name: "Verify grant visible to grantee", phase: 3 },

  // Phase 4
  SEND_MESSAGE_A_TO_B: { name: "Send message A to B", phase: 4 },
  SYNC_MESSAGE_B: { name: "Sync message to B", phase: 4 },
  SEND_MESSAGE_B_TO_A: { name: "Send message B to A", phase: 4 },
  SYNC_MESSAGE_A: { name: "Sync message to A", phase: 4 },
  VERIFY_CONVERSATIONS: { name: "Verify conversation logs", phase: 4 },

  // Phase 5
  RECORD_BALANCE_BEFORE: { name: "Record Agent B balance before transfer", phase: 5 },
  REQUEST_FUNDS_APPROVED: { name: "Request funds (approved by grant)", phase: 5 },
  SYNC_TRANSFER_APPROVAL: { name: "Sync transfer approval (Agent A)", phase: 5 },
  SYNC_TRANSFER_RESULT: { name: "Sync transfer result (Agent B)", phase: 5 },
  VERIFY_BALANCE_INCREASED: { name: "Verify Agent B balance increased", phase: 5 },
  REVOKE_GRANT: { name: "Revoke transfer grant", phase: 5 },
  SYNC_REVOCATION: { name: "Sync revocation to Agent B", phase: 5 },
  REQUEST_FUNDS_REJECTED: { name: "Request funds (rejected, no grant)", phase: 5 },
  SYNC_REJECTION: { name: "Sync rejection (Agent A auto-rejects)", phase: 5 },
  SYNC_REJECTION_RESULT: { name: "Sync rejection result (Agent B)", phase: 5 },
  VERIFY_BALANCE_UNCHANGED: { name: "Verify Agent B balance unchanged", phase: 5 },
} as const;
```

### `helpers.ts`

Shared utilities used by both test files:

```typescript
// Poll `tap message sync` until expected output appears or timeout
waitForSync(options: {
  dataDir: string;
  pattern: string | RegExp;
  timeoutMs?: number;    // default 30_000
  intervalMs?: number;   // default 2_000
}): Promise<CliRunResult>

// Check USDC balance on-chain via RPC
getUsdcBalance(options: {
  address: `0x${string}`;
  chain: string;         // CAIP-2
}): Promise<bigint>

// Assert USDC balance with tolerance
assertBalanceDelta(options: {
  address: `0x${string}`;
  chain: string;
  before: bigint;
  expectedDelta: bigint;
  toleranceBps?: number; // basis points, default 0
}): Promise<void>

// Read contacts.json and assert contact state
assertContactActive(dataDir: string, peerAgentId: number): void

// Read permissions ledger and assert grant state
assertGrantStatus(dataDir: string, grantId: string, status: "active" | "revoked"): void
```

## Timeouts

| Scope | Timeout | Rationale |
|---|---|---|
| Overall suite | 10 minutes | Generous — most runs 3-5 min |
| Per-sync poll | 30 seconds, 2s interval | XMTP usually delivers <2s, but can spike |
| On-chain balance check | 15 seconds | Wait for tx confirmation propagation |
| Registration (IPFS + mint) | 60 seconds | x402 + on-chain tx can be slow |

## Cleanup & Isolation

- Each test run creates fresh temp data dirs for both agents (via `os.tmpdir()`)
- Data dirs are always cleaned up, even on failure (vitest `afterAll`)
- OWS wallets and on-chain agent registrations persist (by design)
- No shared state between chain jobs — fully independent

## Retry semantics

If a release E2E fails:
1. Fix the bug
2. Re-trigger the workflow (push a new tag or use `workflow_dispatch`)
3. Phase 1 re-runs (fresh agents, fresh registration) — this is cheap since the wallets already have funds
4. Phase 2-5 run against the fresh agents

No checkpoint recovery — the full flow reruns. This is intentional: simplicity over saving a few cents.

## Files to delete

- `LIVE_SMOKE_RUNBOOK.md` — replaced by the automated real E2E

## Files to create/modify

| File | Action | Purpose |
|---|---|---|
| `packages/cli/test/e2e/scenarios.ts` | Create | Shared scenario metadata |
| `packages/cli/test/e2e/helpers.ts` | Create | Shared test utilities (polling, assertions) |
| `packages/cli/test/e2e/e2e-live.test.ts` | Create | Real E2E test suite |
| `packages/cli/test/e2e/e2e-mock.test.ts` | Create | Mocked E2E (replaces `e2e-two-agent-flow.test.ts`) |
| `packages/cli/test/e2e-two-agent-flow.test.ts` | Delete | Replaced by `e2e-mock.test.ts` |
| `.github/workflows/release.yml` | Modify | Add E2E gate before publish, add workflow_dispatch |
| `LIVE_SMOKE_RUNBOOK.md` | Delete | Replaced by automated E2E |
| `CLAUDE.md` | Modify | Update E2E maintenance section to reference both test files |

## One-time setup (not repeated per release)

1. Create OWS wallet `e2e-agent-a` with policy for Base + Taiko
2. Create OWS wallet `e2e-agent-b` with policy for Base + Taiko
3. Generate scoped API keys for both wallets
4. Store wallet names + API keys as GitHub Actions secrets in `ggonzalez94/trusted-agents` repo
5. Fund both wallet addresses with USDC on both Base and Taiko (~$5 each, enough for many releases)
