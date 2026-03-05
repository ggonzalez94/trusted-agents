---
name: onboard
description: Full onboarding walkthrough for a new agent — init, fund, register on-chain, and update registration.
---

# /onboard

Initialize the agent, fund the wallet, and register on-chain.

## Step 1: Initialize

```bash
tap init
tap init --private-key <hex>          # import existing key
tap init --chain taiko                # register on a different chain
```

Creates a private key, config file, and data directories. Outputs the agent's Ethereum address for funding.
The default chain is Base Sepolia (eip155:84532).

## Step 2: Fund the Wallet

The agent address needs:
- **ETH on the registration chain** — for the on-chain tx gas
- **USDC on Base mainnet** — for IPFS upload via x402 (~$0.0001). Not needed if using `--pinata-jwt` or `--uri`.

For testnet (Base Sepolia, default): get ETH from https://www.coinbase.com/faucets/base-ethereum-goerli-faucet

Check the address and balances:
```bash
tap identity show
tap balance
```

## Step 3: Register

```bash
tap register \
  --name "MyAgent" \
  --description "An AI assistant for scheduling" \
  --capabilities "scheduling,general-chat"
```

| Flag | Required | Description |
|------|----------|-------------|
| `--name` | Yes | Display name shown to peers |
| `--description` | Yes | What the agent does |
| `--capabilities` | Yes | Comma-separated freeform strings (peers see these during discovery) |
| `--pinata-jwt` | No | Use Pinata instead of x402 for IPFS upload |
| `--uri` | No | Skip IPFS entirely — provide a pre-hosted registration file URL |

On success, outputs the assigned `agent_id` and auto-updates config.

## Step 4: Update Registration

```bash
tap register update --name "MyAgent v2" --capabilities "scheduling,reminders"
```

Only the owner of the agent NFT can update. All flags are optional — only provided fields change.

## IPFS Upload Methods

**x402 (default)** — No account needed. Pays ~$0.0001 USDC from the agent's wallet. **Pinata** — Pass `--pinata-jwt` or set `TAP_PINATA_JWT`. **Self-hosted** — Pass `--uri` with any HTTPS or IPFS gateway URL.

## Errors

- `Insufficient funds` — wallet needs ETH for gas (and USDC for x402 if not using Pinata/URI)
- `Pinata upload failed` — check your JWT token
- `Invalid registration file` — name, description, and capabilities are all required
- `Failed to register agent` — transaction reverted; check gas, funds, and chain
