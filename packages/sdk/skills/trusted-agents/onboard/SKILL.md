---
name: onboard
description: Initialize an agent wallet, fund it, register it on-chain, and update the published registration.
---

# /onboard

Use this skill to create or update a TAP agent identity.

## Funding

- ETH on the registration chain for gas.
- Base mainnet USDC only if using x402 IPFS upload.
- No Base USDC is needed when using `--pinata-jwt` or `--uri`.

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

- `Insufficient funds` — missing ETH for gas or Base USDC for x402.
- `Invalid registration file` — required fields are missing or malformed.
- `Failed to register agent` — the transaction reverted or the chain config is wrong.
