# Registering a TAP Agent on Taiko

Here is what you need to know about funding and IPFS uploads when registering on Taiko instead of Base.

## Overview

TAP agent registration involves two main on-chain and off-chain steps:

1. Uploading your registration metadata to IPFS
2. Minting an ERC-8004 identity token on the target chain (Taiko in your case)

These two steps have different funding requirements, and on Taiko specifically there is an asymmetry you need to be aware of.

## Key Asymmetry: IPFS Upload vs. Chain Registration

**IPFS uploads always use Base mainnet USDC for payment (x402 protocol), regardless of which chain you register on.** This means even though your agent identity will live on Taiko, you still need Base mainnet USDC to pay for the IPFS content upload.

Your registration transaction (the ERC-8004 mint) will use Taiko's native token (ETH on Taiko).

## What You Need to Fund Before Starting

Before running any commands, make sure your agent wallet has:

1. **Base mainnet ETH** (for gas on Base, needed for the IPFS x402 payment transaction)
2. **Base mainnet USDC** (the actual payment token for the IPFS upload via x402)
3. **Taiko ETH** (for gas on Taiko to submit the ERC-8004 registration transaction)

Your agent wallet address will be derived from the private key generated during `tap init`. You will not know this address until after initialization, so the typical flow is:

- Run `tap init`
- Note the wallet address printed during init
- Fund it on both Base mainnet and Taiko before proceeding to register

## Step-by-Step Commands

### Step 1: Initialize your agent

```bash
tap init
```

This generates your private key and writes an initial config with `agent_id: -1`. Note the wallet address printed — you need to fund it before continuing.

### Step 2: Fund your wallet

Before running `tap register`, send:
- USDC (Base mainnet) to your wallet address — for the IPFS upload payment
- ETH (Base mainnet) to your wallet address — for gas on the IPFS payment transaction
- ETH (Taiko mainnet) to your wallet address — for gas on the Taiko registration transaction

### Step 3: Register on Taiko

```bash
tap register --chain taiko
```

The `--chain taiko` flag tells the CLI to submit the ERC-8004 mint on Taiko. The CLI accepts `taiko` as a chain alias and normalizes it internally to the correct CAIP-2 identifier.

If you want to use Taiko's testnet instead:

```bash
tap register --chain taiko-houdi
```

## What Happens During Registration

1. The CLI builds your registration file (containing your XMTP endpoint address, agent address, and service metadata).
2. It uploads the registration file to IPFS — this is where Base mainnet USDC is charged via x402.
3. The resulting IPFS URI (`ipfs://...`) is written into the ERC-8004 mint transaction submitted on Taiko.
4. On success, your `agent_id` is written back into your config file.

## IPFS Upload Caching

The CLI caches successful IPFS uploads at `<dataDir>/ipfs-cache.json`. If you need to re-run `tap register` (for example, after a failed on-chain step), it will reuse the cached IPFS CID rather than uploading and charging again — as long as the content hash matches and the CID is still reachable on IPFS.

## Summary

| Requirement | Network | Token |
|---|---|---|
| IPFS metadata upload | Base mainnet | USDC (via x402) |
| Registration transaction gas | Taiko | ETH |

The critical thing to remember: **you need Base mainnet USDC even when registering on Taiko.** This is not obvious from the command flags alone.
