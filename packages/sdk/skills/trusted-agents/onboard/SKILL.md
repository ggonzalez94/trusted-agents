---
name: onboard
description: Initialize a TAP agent wallet, fund it, register it on-chain, and update the published registration. Use this skill whenever a TAP identity needs a new `dataDir`, wallet, ERC-8004 registration, or registration file update before messaging or OpenClaw plugin setup.
---

# /onboard

Use this skill to create or update a TAP agent identity.

Prerequisite:

- If `tap` is not installed yet, read `../references/install-cli.md` first.

## Funding

- Base and Base Sepolia default to EIP-7702 with Circle Paymaster, so TAP uses chain-local USDC for gas on those chains.
- Other chains use native gas.
- Base mainnet USDC only if using x402 IPFS upload.
- No Base USDC is needed when using `--pinata-jwt` or `--uri`.
- In OpenClaw plugin mode, onboarding still happens with the `tap` CLI before the plugin points at that `dataDir`.

## Commands

### `tap init [--private-key <hex>] [--chain <name>]`

Create or import the wallet and local config.

```bash
tap init --chain base-sepolia
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

## Common Errors

- `Insufficient funds` — missing chain-local gas funding for the selected execution mode, or Base mainnet USDC for x402.
- `Invalid registration file` — required fields are missing or malformed.
- `Failed to register agent` — the transaction reverted or the chain config is wrong.
