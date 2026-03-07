# Live Smoke Runbook

## Purpose

This is the broader real-world smoke test for TAP.

Use it to validate:
- XMTP delivery with real listeners
- Base Sepolia value transfer with real funds
- directional grant propagation between real agents
- the full operator workflow outside the deterministic GH-safe E2E

Do not use this as a required pull-request gate. Run it manually or on a scheduled canary.

## Treasury Wallet Source

The agent running this scenario should expect the prefunded treasury wallet to come from a secure secret source, not from the repo.

Recommended sources:
- local/manual run: an operator exports `TAP_SMOKE_TREASURY_PRIVATE_KEY` from a secret manager such as 1Password, Doppler, or AWS Secrets Manager
- GitHub Actions `workflow_dispatch` or nightly run: a protected GitHub Environment secret named `TAP_SMOKE_TREASURY_PRIVATE_KEY`

Do not commit the treasury key, the agent keys, or funding mnemonics to the repository.

## Required Secrets

- `TAP_SMOKE_TREASURY_PRIVATE_KEY`
- `TAP_SMOKE_AGENT_A_PRIVATE_KEY`
- `TAP_SMOKE_AGENT_B_PRIVATE_KEY`
- `TAP_SMOKE_AGENT_A_ID`
- `TAP_SMOKE_AGENT_B_ID`

Optional:
- `TAP_SMOKE_AGENT_A_CHAIN`
- `TAP_SMOKE_AGENT_B_CHAIN`

Defaults:
- chain: `eip155:84532`
- XMTP env: `dev`

## Wallet Roles

- Treasury wallet:
  - prefunded
  - used only to top up agent wallets before the test
- Agent A:
  - typically the payer/treasury agent in the scenario
- Agent B:
  - typically the requester/worker agent in the scenario

## Safety Rules

- Use Base Sepolia only.
- Keep small transfer amounts.
- Do not use mainnet assets.
- Cap the approved live transfer to `0.001 ETH` or less.
- Prefer interactive approval for the high-impact action check. Avoid `--yes-actions` if the goal is to validate runtime judgment.

## Transport Rule

For v1 live XMTP runs, keep only one transport-active CLI process per identity at a time.

That means:
- run `tap message listen` only for the identity that should receive the next inbound step
- before running `tap connect`, `tap permissions grant`, `tap permissions revoke`, `tap message send`, or `tap message request-funds` for an identity, stop any long-running listener for that same identity first
- restart the listener afterward only if that identity needs to receive the next inbound message or grant update

## Minimum Starting Balances

- Agent A: at least `0.02 ETH`
- Agent B: at least `0.01 ETH`
- Treasury wallet: enough ETH to refill both agents and cover repeated runs
- If Agent A or Agent B keeps the default Base Sepolia `execution.mode: eip7702`, also provision a small Base Sepolia USDC balance for gas. The checked-in top-up helper only funds ETH.

## Scenario

### 1. Create fresh agent homes

```bash
AGENT_A_DIR="$(mktemp -d /tmp/tap-live-a.XXXXXX)"
AGENT_B_DIR="$(mktemp -d /tmp/tap-live-b.XXXXXX)"
```

### 2. Initialize from the pre-registered keys

```bash
tap --data-dir "$AGENT_A_DIR" init --private-key "$TAP_SMOKE_AGENT_A_PRIVATE_KEY"
tap --data-dir "$AGENT_B_DIR" init --private-key "$TAP_SMOKE_AGENT_B_PRIVATE_KEY"

tap --data-dir "$AGENT_A_DIR" config set agent_id "$TAP_SMOKE_AGENT_A_ID"
tap --data-dir "$AGENT_B_DIR" config set agent_id "$TAP_SMOKE_AGENT_B_ID"
```

### 3. Top up from the treasury wallet

Resolve the two agent addresses:

```bash
AGENT_A_ADDRESS="$(tap --json --data-dir "$AGENT_A_DIR" balance | jq -r '.data.address')"
AGENT_B_ADDRESS="$(tap --json --data-dir "$AGENT_B_DIR" balance | jq -r '.data.address')"
```

Use the checked-in helper so the funding step is reproducible and does not depend on repo-stored secrets:

```bash
bun packages/cli/scripts/live-smoke-top-up.ts \
  --ensure "$AGENT_A_ADDRESS:0.02:0.001" \
  --ensure "$AGENT_B_ADDRESS:0.01:0.001"
```

Expected behavior:
- the agent running this scenario does not discover the treasury key from repo files
- the treasury key is already available in the environment or secret manager context
- all funding happens through environment variables or a secret manager, never through tracked files

If both agents are already above the threshold and you still want to validate the treasury path itself, run one small explicit transfer:

```bash
bun packages/cli/scripts/live-smoke-top-up.ts --send "$AGENT_B_ADDRESS:0.0001"
```

### 4. Verify balances and on-chain identity

```bash
tap --data-dir "$AGENT_A_DIR" balance
tap --data-dir "$AGENT_B_DIR" balance
tap --data-dir "$AGENT_A_DIR" identity resolve-self
tap --data-dir "$AGENT_B_DIR" identity resolve-self
```

### 5. Start Agent A's listener

Start the inviter first. Agent B does not need a listener yet.

```bash
tap --data-dir "$AGENT_A_DIR" message listen --yes
```

### 6. Create initial grant files

Example worker request:

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

Example worker offer:

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

### 7. Connect with initial grant intent

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

### 8. Start Agent B's listener and publish Agent A's grants

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

### 9. Send messages both directions

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

### 10. Run one approved transfer request

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

### 11. Stop Agent A's listener, start Agent B's listener, and revoke the transfer grant

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

### 12. Stop Agent B's listener, restart Agent A's listener, and run one rejected transfer request

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

### 13. Inspect artifacts

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

## Failure Triage

- outbound command times out while a listener for the same identity is running
  - stop the listener for that identity and retry the command
- `Peer not found in contacts`
  - connect did not complete or the wrong data dir is in use
- `Agent not found on-chain`
  - wrong `agent_id` or wrong chain
- `Peer ... is not reachable`
  - listener not running or XMTP session is unhealthy
- missing async action response
  - retry with a fresh listener session for the requester identity
- insufficient funds
  - top up from the treasury wallet before continuing

## Automation Guidance

If this becomes automated later:
- prefer `workflow_dispatch` or nightly cron
- store all keys in protected environment secrets
- add a top-up helper step before the smoke flow
- publish the tx hash, permissions snapshots, and ledger tails as workflow artifacts
