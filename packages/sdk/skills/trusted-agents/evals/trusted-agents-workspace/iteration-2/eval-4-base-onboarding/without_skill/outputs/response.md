# Setting Up a New TAP Agent on Base Mainnet

Here is a step-by-step walkthrough for onboarding a new TAP agent on Base mainnet, assuming you have `tap` already installed and 1 USDC on Base.

---

## Overview

Setting up a TAP agent involves:
1. Initializing a local agent identity
2. Registering it on-chain (ERC-8004 on Base mainnet)
3. Uploading your registration metadata (to IPFS)
4. Verifying your setup

You will need a small amount of USDC for the IPFS upload fee, and ETH for the on-chain registration transaction gas.

---

## Step 1: Initialize Your Agent

Run `tap init` to generate a new local identity (private key) and create the initial config file.

```bash
tap init
```

This creates a local data directory (default: `~/.trustedagents`) containing:
- `config.yaml` — your agent configuration
- `identity/agent.key` — your private key (keep this safe, chmod 0600)

At this point your agent has no on-chain identity yet (`agent_id` will be `-1` in config).

If you want to isolate this agent or run multiple agents on the same machine, use a custom data directory:

```bash
tap init --data-dir ~/my-tap-agent
```

---

## Step 2: Fund the Agent Wallet

After `tap init`, check what address was generated:

```bash
tap whoami
```

This shows your agent's Ethereum address. You need to:
- Send some ETH to this address on Base mainnet for gas fees (a small amount, e.g. 0.002–0.005 ETH is usually enough)
- Send your 1 USDC to this address on Base mainnet, as it will be used to pay for the IPFS registration upload

---

## Step 3: Register Your Agent On-Chain

Run `tap register` to:
- Upload your agent registration metadata to IPFS (paid with USDC)
- Mint an ERC-8004 token on Base mainnet (costs ETH for gas)
- Store your assigned `agent_id` back into your config

```bash
tap register --chain base
```

During this process, TAP will:
1. Construct your registration file (including your XMTP endpoint address)
2. Upload it to IPFS, paying with USDC via x402
3. Submit the on-chain registration transaction
4. Update `config.yaml` with your new `agent_id`

If you used a custom data directory:

```bash
tap register --chain base --data-dir ~/my-tap-agent
```

---

## Step 4: Verify Registration

After registration completes, confirm your agent is fully set up:

```bash
tap whoami
```

You should now see your `agent_id` (a non-negative integer), your wallet address, and your chain.

You can also resolve your agent to confirm the on-chain registration is readable:

```bash
tap resolve <your-agent-id> --chain base
```

This fetches your token URI from the ERC-8004 contract and validates your registration file.

---

## Step 5: Start Listening for Messages (Optional)

Once registered, your agent can receive messages over XMTP. To start a persistent listener:

```bash
tap message listen
```

This will process incoming connection requests, messages, and action requests in real time.

---

## Notes and Caveats

- **1 USDC may be tight.** The IPFS upload via x402 uses Base mainnet USDC. If the fee is close to 1 USDC, make sure you also have ETH for gas separately. The IPFS payment and gas are separate costs.
- **Private key security.** Your `identity/agent.key` file is the root of your agent's identity. Back it up securely.
- **Chain flag.** Use `--chain base` to target Base mainnet explicitly. Without it, the default chain in your config is used (which may be a testnet if you haven't configured it).
- **Data directory.** All agent state is scoped to your data directory. The default is `~/.trustedagents`. Use `TAP_DATA_DIR` env var or `--data-dir` flag to override.

---

## Summary of Commands

```bash
# 1. Initialize agent identity
tap init

# 2. Check your agent address (then fund it with ETH + USDC)
tap whoami

# 3. Register on Base mainnet
tap register --chain base

# 4. Verify registration
tap whoami
tap resolve <agent-id> --chain base

# 5. (Optional) Start listening for messages
tap message listen
```
