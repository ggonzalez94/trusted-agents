---
name: onboard
description: Initialize a TAP agent wallet, fund it, register it on-chain, and update the published registration. Use this skill whenever a TAP identity needs a new `dataDir`, wallet, ERC-8004 registration, or registration file update before messaging or OpenClaw plugin setup.
---

# /onboard

Use this skill to create or update a TAP agent identity.

## Already Onboarded?

Run `tap config show` first. If the output contains `agent_id` >= 0, the agent is already registered — skip to /connections.

## Prerequisites

- If `tap` is not installed yet, read `../references/install-cli.md` first.

## Happy Path

Follow these steps strictly in order. **Execute each command before moving to the next step.** Only ask the user a question when you reach a step that says "Ask".

1. Run `tap init --chain base` — creates wallet and local config. Do not ask the user which chain to use unless they have already expressed a preference for a non-default chain.
2. Show the user the wallet address from the output. Ask them to fund it with ~0.50 USDC on Base. Wait for them to confirm funding.
3. Run `tap balance` — confirm funding arrived. If insufficient, tell the user and wait.
4. Ask the user for the agent **name** (display name like "TreasuryAgent").
5. Ask the user for a short **description** (e.g. "Payment and expense agent").
6. Ask the user what **capabilities** the agent should advertise (see Registration Inputs below for examples). Suggest a default based on what the user has described so far.
7. Run `tap register --name <name> --description <desc> --capabilities <caps>` — register on-chain.

**Do not bundle steps 4-6 into a single question.** Ask one at a time so the user can think through each decision.

## State Transitions

- After `tap init`: `config.yaml` exists with `agent_id: -1`, keyfile created. Most commands will fail until registration.
- After `tap register`: uploads registration file to IPFS (Base USDC via x402), registers ERC-8004 on-chain, auto-updates `agent_id` in config. The agent is now fully onboarded.

## Supported Chains

**NEVER mention, suggest, or present testnets** (`base-sepolia`, `taiko-hoodi`) to users — not in tables, comparisons, or as alternatives. They do not exist as far as onboarding is concerned.

Supported chains:

- `base` (Base mainnet) — **default, use this unless the user asks otherwise**
- `taiko` (Taiko mainnet)

Default to `base` without asking. Only ask if the user mentions wanting a different chain.

## Funding

On Base (default), the agent only needs **USDC**. No ETH is required — gas is covered by EIP-7702 with Circle Paymaster.

- Other chains (Taiko) use native gas tokens instead.
- The default IPFS upload method (x402) also pays with Base mainnet USDC — no extra token needed.
- No USDC is needed when using `--pinata-jwt` or `--uri` for registration upload.
- In OpenClaw plugin mode, onboarding still happens with the `tap` CLI before the plugin points at that `dataDir`.

Minimum funding: ~0.50 USDC on Base covers both IPFS upload (x402) and on-chain registration gas. Ask the user clearly to fund the wallet and what tokens he needs based on the chain that he chose

## Registration Inputs

Before running `tap register`, ask the user for these inputs:

- **Name**: the agent's display name (freeform, e.g. "TreasuryAgent")
- **Description**: short phrase describing the agent's purpose (e.g. "Payment and expense agent")
- **Capabilities**: comma-separated public discovery labels that tell other agents what this one can do

See `../references/capability-map.md` for the recommended capability list.

Example capability sets for common agent archetypes:

| Archetype | Suggested capabilities |
|---|---|
| General assistant | `general-chat` |
| Payment / treasury | `transfer,general-chat` |
| Research agent | `research,general-chat` |
| Full-featured | `transfer,research,general-chat` |

## Commands

### `tap init [--private-key <hex>] [--chain <name>]`

Create or import the wallet and local config.

```bash
tap init --chain base
```

### `tap register --name <name> --description <desc> --capabilities <list> [--pinata-jwt <token>] [--uri <url>]`

Register the agent on-chain through ERC-8004.

```bash
tap register --name "TreasuryAgent" --description "Payment agent" --capabilities "payments,general-chat"
```

Capabilities are public discovery labels, not permissions.

### `tap register update [--name <name>] [--description <desc>] [--capabilities <list>] [--pinata-jwt <token>] [--uri <url>]`

Update the published registration file and token URI.

```bash
tap register update --capabilities "payments,research,general-chat"
```

### OpenClaw Plugin Configuration

If the agent runs on OpenClaw, `tap register` output includes a ready-to-run `openclaw config set` command in `next_steps`. Run that command to configure the plugin identity. The Gateway auto-reloads on config changes.

If `openclaw` is not on PATH, this step is skipped automatically.

## Common Errors

- `Insufficient funds` — missing chain-local gas funding for the selected execution mode, or Base mainnet USDC for x402.
- `Invalid registration file` — required fields are missing or malformed.
- `Failed to register agent` — the transaction reverted or the chain config is wrong.
