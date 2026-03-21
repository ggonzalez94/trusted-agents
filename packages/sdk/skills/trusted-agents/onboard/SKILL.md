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

1. `tap init` — create wallet and local config
2. Ask the user to fund the wallet with USDC on Base (show the wallet address from `tap init` output)
3. `tap balance` — confirm funding arrived
4. Ask the user for name, description, and capabilities (see Registration Inputs below)
5. `tap register` — register on-chain

## State Transitions

- After `tap init`: `config.yaml` exists with `agent_id: -1`, keyfile created. Most commands will fail until registration.
- After `tap register`: uploads registration file to IPFS (Base USDC via x402), registers ERC-8004 on-chain, auto-updates `agent_id` in config. The agent is now fully onboarded.

## Supported Chains

Always onboard on a mainnet chain. Supported mainnets:

- `base` (Base mainnet) — default and recommended
- `taiko` (Taiko mainnet)

Always ask the user what chain he wants to use.

Do not suggest or use testnets (`base-sepolia`, `taiko-hoodi`) when onboarding users. Testnet infrastructure is incomplete and not suitable for production use.

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
