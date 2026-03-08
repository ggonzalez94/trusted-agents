# Live Smoke Runbook

## Purpose

This is the broader real-world smoke test for TAP.

Use it to validate:
- XMTP delivery with real listeners
- Base Sepolia value transfer with real funds
- directional grant propagation between real agents
- the full operator workflow outside the deterministic GH-safe E2E
- optionally, fresh x402-backed registration before the messaging flow

Do not use this as a required pull-request gate. Run it manually or on a scheduled canary.

## What This Covers

There are two valid ways to run this smoke:

- full path:
  - fresh local agent homes
  - fresh on-chain registration
  - x402 IPFS upload
  - connect, grants, messaging, approved transfer, revoke, rejected transfer
- skip-registration path:
  - start from already-registered agents
  - skip fresh x402 registration
  - still run connect, grants, messaging, approved transfer, revoke, rejected transfer

Use the full path when the agent wallets have a small amount of Base mainnet USDC available for x402. Otherwise skip that part and start from already-registered agents.

## Secrets

Required:
- `TAP_SMOKE_TREASURY_PRIVATE_KEY`
- `TAP_SMOKE_AGENT_A_PRIVATE_KEY`
- `TAP_SMOKE_AGENT_B_PRIVATE_KEY`

Optional:
- `TAP_PINATA_JWT`

Notes:
- `TAP_PINATA_JWT` is not needed for the x402 path.
- If you use `TAP_PINATA_JWT`, you are not testing x402 upload.
- Do not commit the treasury key, the agent keys, or any funding mnemonic to the repository.

## Basic Prerequisites

- `tap` is installed and points at the current build
- `bun` is available
- `jq` is available
- you can use at least two terminal sessions

Wallet/funding assumptions:
- Treasury wallet:
  - enough Base Sepolia ETH to top up both agents
- Agent A and Agent B:
  - Agent A: at least `0.02 ETH`, Agent B: at least `0.01 ETH`
  - If an agent keeps the default Base Sepolia `execution.mode: eip7702`, also provision a small Base Sepolia USDC balance for gas. The checked-in top-up helper only funds ETH.
- Full x402 path only:
  - each agent wallet has a small amount of USDC on Base mainnet for the IPFS upload

The checked-in top-up helper only handles Base Sepolia ETH. If you want to exercise x402 registration, make sure the agent wallets already have Base mainnet USDC before you call `tap register`.

## Wallet Roles

- Treasury wallet:
  - prefunded
  - used only to top up agent wallets before the test
- Agent A:
  - typically the payer or treasury agent in the scenario
  - typically the inviter
- Agent B:
  - typically the requester or worker agent in the scenario

## Runtime Rule

For v1 live XMTP runs, keep only one transport-active CLI process per identity at a time.

That means:
- run `tap message listen` only for the identity that should receive the next inbound step
- before running `tap connect`, `tap permissions request`, `tap permissions grant`, `tap permissions revoke`, `tap message send`, or `tap message request-funds` for an identity, stop any long-running listener for that same identity first
- restart the listener afterward only if that identity needs to receive the next inbound message or grant update

## Shared Files

Use whatever paths are convenient. The examples below assume the current working directory.

Worker request:

```json
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "worker-chat",
      "scope": "general-chat"
    },
    {
      "grantId": "worker-native-budget",
      "scope": "transfer/request",
      "constraints": {
        "asset": "native",
        "chain": "eip155:84532",
        "maxAmount": "0.001",
        "window": "week"
      }
    }
  ]
}
```

Worker offer:

```json
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "treasury-chat",
      "scope": "general-chat"
    }
  ]
}
```

Treasury grants:

```json
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "worker-chat",
      "scope": "general-chat"
    },
    {
      "grantId": "worker-native-budget",
      "scope": "transfer/request",
      "constraints": {
        "asset": "native",
        "chain": "eip155:84532",
        "maxAmount": "0.001",
        "window": "week"
      }
    }
  ]
}
```

One simple way to write them:

```bash
cat > ./worker-request.json <<'EOF'
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "worker-chat",
      "scope": "general-chat"
    },
    {
      "grantId": "worker-native-budget",
      "scope": "transfer/request",
      "constraints": {
        "asset": "native",
        "chain": "eip155:84532",
        "maxAmount": "0.001",
        "window": "week"
      }
    }
  ]
}
EOF

cat > ./worker-offer.json <<'EOF'
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "treasury-chat",
      "scope": "general-chat"
    }
  ]
}
EOF

cat > ./treasury-grants.json <<'EOF'
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "worker-chat",
      "scope": "general-chat"
    },
    {
      "grantId": "worker-native-budget",
      "scope": "transfer/request",
      "constraints": {
        "asset": "native",
        "chain": "eip155:84532",
        "maxAmount": "0.001",
        "window": "week"
      }
    }
  ]
}
EOF
```

## Path Selection

Choose one:

### Path A: Base Mainnet USDC Available

Use this when both agent wallets can pay for x402 upload.

This path exercises:
- fresh local setup
- fresh `tap register`
- x402 IPFS upload
- the full messaging and action flow

### Path B: Base Mainnet USDC Not Available

Use this when you still want to validate TAP runtime behavior but do not want this run to depend on x402 funding.

This path:
- skips fresh x402 registration
- assumes each agent already has a valid TAP data dir with a registered `agent_id`
- still exercises the major live messaging, grants, and action checks

If the agents are not already registered, either:
- top them up with Base mainnet USDC and use Path A, or
- register them some other way first, for example `--pinata-jwt` or `--uri`, then continue with the shared flow

## Path A: Full Flow With Fresh x402 Registration

### 1. Create fresh agent homes

```bash
AGENT_A_DIR="$(mktemp -d /tmp/tap-live-a.XXXXXX)"
AGENT_B_DIR="$(mktemp -d /tmp/tap-live-b.XXXXXX)"
```

### 2. Initialize from the private keys

```bash
tap --data-dir "$AGENT_A_DIR" init --private-key "$TAP_SMOKE_AGENT_A_PRIVATE_KEY"
tap --data-dir "$AGENT_B_DIR" init --private-key "$TAP_SMOKE_AGENT_B_PRIVATE_KEY"
```

### 3. Resolve the two agent addresses

```bash
AGENT_A_ADDRESS="$(tap --json --data-dir "$AGENT_A_DIR" balance | jq -r '.data.address')"
AGENT_B_ADDRESS="$(tap --json --data-dir "$AGENT_B_DIR" balance | jq -r '.data.address')"
```

### 4. Top up Base Sepolia ETH from the treasury wallet

```bash
bun packages/cli/scripts/live-smoke-top-up.ts \
  --ensure "$AGENT_A_ADDRESS:0.02:0.001" \
  --ensure "$AGENT_B_ADDRESS:0.01:0.001"
```

If both agents are already above the threshold and you still want to validate the treasury path itself, run one small explicit transfer:

```bash
bun packages/cli/scripts/live-smoke-top-up.ts --send "$AGENT_B_ADDRESS:0.0001"
```

### 5. Make sure both agent wallets also have Base mainnet USDC

This runbook does not prescribe how to do that. Use whatever wallet tooling or funding flow you already trust.

The only requirement for this branch is that both agent wallets can pay the x402 IPFS upload before `tap register` runs.

### 6. Register both agents

```bash
tap --data-dir "$AGENT_A_DIR" register \
  --name "TreasuryAgent" \
  --description "Live smoke treasury agent" \
  --capabilities "payments,general-chat"

tap --data-dir "$AGENT_B_DIR" register \
  --name "WorkerAgent" \
  --description "Live smoke worker agent" \
  --capabilities "payments,general-chat"
```

Expected behavior:
- each command uploads the registration file through x402
- each command writes the returned `agent_id` back into the local config

### 7. Verify balances and on-chain identity

```bash
tap --data-dir "$AGENT_A_DIR" balance
tap --data-dir "$AGENT_B_DIR" balance
tap --data-dir "$AGENT_A_DIR" identity resolve-self
tap --data-dir "$AGENT_B_DIR" identity resolve-self
```

Continue with the shared live flow below.

## Path B: Skip Fresh x402 Registration

### 1. Point at already-registered agent homes

Use any two existing TAP data dirs that already contain:
- the imported private key
- the correct `agent_id`
- a registration that resolves on-chain

For example:

```bash
AGENT_A_DIR="/path/to/existing/treasury-agent"
AGENT_B_DIR="/path/to/existing/worker-agent"
```

### 2. Verify the local state is usable

```bash
tap --data-dir "$AGENT_A_DIR" balance
tap --data-dir "$AGENT_B_DIR" balance
tap --data-dir "$AGENT_A_DIR" identity resolve-self
tap --data-dir "$AGENT_B_DIR" identity resolve-self
```

If both agents resolve cleanly, continue with the shared live flow below.

## Shared Live Flow

### 1. Start Agent A's listener

Start the inviter first. Agent B does not need a listener yet.

```bash
tap --data-dir "$AGENT_A_DIR" message listen --yes
```

### 2. Connect with initial grant intent

```bash
INVITE_URL="$(tap --json --data-dir "$AGENT_A_DIR" invite create | jq -r '.data.url')"

tap --data-dir "$AGENT_B_DIR" connect "$INVITE_URL" \
  --yes \
  --request-grants-file ./worker-request.json \
  --grant-file ./worker-offer.json
```

Checks:
- the connector sees requested and offered grants in the command output
- Agent A listener shows the peer's requested and offered grant intent

### 3. Optionally request an additional grant later

This is not required for the main smoke path, but it is a useful extra check if you want to cover the explicit `permissions request` command as well.

### 4. Start Agent B's listener and publish Agent A's grants

Start Agent B's listener so it can receive the grant publication:

```bash
tap --data-dir "$AGENT_B_DIR" message listen --yes
```

Use `Ctrl+C` to stop Agent A's listener before publishing from Agent A, then restart it after the publish completes:

```bash
tap --data-dir "$AGENT_A_DIR" permissions grant WorkerAgent --file ./treasury-grants.json --note "approved for smoke run"
tap --data-dir "$AGENT_A_DIR" message listen --yes
```

Checks:
- `tap permissions show WorkerAgent`
- `tap permissions show TreasuryAgent`

### 5. Send messages both directions

Agent B can send first while Agent A's listener is already running:

```bash
tap --data-dir "$AGENT_B_DIR" message send TreasuryAgent "hello from live smoke" --scope general-chat
```

Then stop Agent A's listener, send from Agent A to Agent B, and restart Agent A's listener afterward:

```bash
tap --data-dir "$AGENT_A_DIR" message send WorkerAgent "hello back from live smoke" --scope general-chat
tap --data-dir "$AGENT_A_DIR" message listen --yes
```

Use `Ctrl+C` to stop the currently running listener before starting the next command for that same identity.

### 6. Run one approved transfer request

Stop Agent B's listener before requesting funds so the request command can receive the async response itself.

```bash
tap --data-dir "$AGENT_B_DIR" message request-funds TreasuryAgent \
  --asset native \
  --amount 0.0002 \
  --chain base-sepolia \
  --note "approved live smoke transfer"
```

Checks:
- Agent A listener shows the transfer request, active transfer grants, and ledger path
- the operator approves
- Agent B receives a completed response with tx hash

### 7. Stop Agent A's listener, start Agent B's listener, and revoke the transfer grant

Agent B must be listening to receive the grant update, and Agent A should not have its own listener running while it sends the revoke.

```bash
tap --data-dir "$AGENT_B_DIR" message listen --yes
```

Use `Ctrl+C` to stop Agent A's listener before running the revoke command.

```bash
tap --data-dir "$AGENT_A_DIR" permissions revoke WorkerAgent \
  --grant-id worker-native-budget \
  --note "revoked during live smoke"
```

### 8. Stop Agent B's listener, restart Agent A's listener, and run one rejected transfer request

Use `Ctrl+C` to stop Agent B's listener before restarting Agent A's listener.

```bash
tap --data-dir "$AGENT_A_DIR" message listen --yes
tap --data-dir "$AGENT_B_DIR" message request-funds TreasuryAgent \
  --asset native \
  --amount 0.0001 \
  --chain base-sepolia \
  --note "should be rejected after revoke"
```

Checks:
- Agent A listener shows no active transfer grants
- the operator rejects
- Agent B receives a rejection

### 9. Inspect artifacts

```bash
tap --data-dir "$AGENT_A_DIR" permissions show WorkerAgent
tap --data-dir "$AGENT_B_DIR" permissions show TreasuryAgent
tap --data-dir "$AGENT_A_DIR" conversations list --with WorkerAgent
tap --data-dir "$AGENT_B_DIR" conversations list --with TreasuryAgent
tail -n 80 "$AGENT_A_DIR/notes/permissions-ledger.md"
tail -n 80 "$AGENT_B_DIR/notes/permissions-ledger.md"
```

Required results:
- connection succeeds and both agents appear in `contacts list`
- `permissions show` on both sides reflects directional grants and later the revoked status
- both `message send` commands succeed
- the approved request returns `status=completed` and a tx hash
- the rejected request returns a rejection error and logs a rejection in the ledgers
- both ledgers contain grant and transfer events

## Pass Criteria

The smoke run passes only if all of the following are true:
- both agents resolve on-chain and have live Base Sepolia balances
- connect succeeds and both sides surface the requested and offered grant intent
- `tap permissions show` reflects the expected directional grant state on both agents
- at least one normal chat message succeeds in each direction
- one native transfer request is approved and returns a tx hash
- the transfer grant is revoked and the next transfer request is rejected
- both agents have conversation history and permissions-ledger entries for the request, completion, revocation, and rejection

Full-path-only extra pass criteria:
- both fresh `tap register` commands succeed
- both registrations resolve on-chain after registration
- the resulting local configs contain the returned `agent_id`

## Failure Triage

- outbound command times out while a listener for the same identity is running
  - stop the listener for that identity and retry the command
- `Agent not found on-chain`
  - wrong data dir, wrong chain, or registration did not complete
- `Peer not found in contacts`
  - connect did not complete or the wrong data dir is in use
- `Peer ... is not reachable`
  - listener not running or XMTP session is unhealthy
- x402 upload fails before registration
  - the registering wallet likely does not have enough Base mainnet USDC
- missing async action response
  - retry with a fresh listener session for the requester identity
- insufficient funds
  - top up from the treasury wallet before continuing

## Automation Guidance

If this becomes automated later:
- prefer `workflow_dispatch` or nightly cron
- store all keys in protected environment secrets
- add a top-up helper step before the smoke flow
- treat Base Sepolia ETH funding and Base mainnet USDC funding as separate setup concerns
- publish the tx hash, permissions snapshots, and ledger tails as workflow artifacts
