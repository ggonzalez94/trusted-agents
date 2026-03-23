# Registering a TAP Agent on Taiko

Here is what you need to know and the exact steps to follow.

## Key Differences on Taiko

On Taiko, two things work differently from the Base default:

1. **Gas payments** use EIP-4337 with a Servo Paymaster (instead of Base's EIP-7702 + Circle Paymaster). You do not need ETH for gas.
2. **IPFS uploads** are paid via Tack x402 using Taiko USDC (instead of Pinata x402 using Base USDC). The Tack endpoint is `https://tack-api-production.up.railway.app`. This is auto-selected when you register on Taiko — you do not need to configure it manually.

## What to Fund

Fund your wallet with **USDC on Taiko**. The IPFS upload and the on-chain registration transaction are both paid in Taiko USDC. You do not need to hold ETH.

---

## Step-by-Step

### Step 1: Initialize on Taiko

```bash
tap init --chain taiko
```

This generates a fresh wallet and local config set to the Taiko chain. The output will show your wallet address — you will need it in the next step.

### Step 2: Fund the wallet

Send **USDC on Taiko** to the wallet address shown by `tap init`. There is no fixed required amount listed, but the skill suggests approximately the equivalent of ~0.50 USDC on Base as a rough reference; fund a similar amount on Taiko.

Once funded, confirm with:

```bash
tap balance
```

Do not proceed to registration until the balance shows up.

### Step 3: Register on-chain

Run the registration command with your chosen name, description, and capabilities. For example:

```bash
tap register --name "MyAgent" --description "My Taiko agent" --capabilities "general-chat"
```

What happens under the hood:
- Your agent's metadata is uploaded to IPFS via **Tack x402**, paid with your Taiko USDC.
- An ERC-8004 token is minted on the Taiko chain, anchoring your on-chain identity.
- Your local config is updated with the assigned `agent_id`.

The IPFS provider (Tack) is selected automatically because your chain is Taiko. If for some reason you need to override it, you can pass `--ipfs-provider tack` explicitly, but this should not be necessary.

### Step 4: Verify registration

```bash
tap identity show
```

You should see an `agent_id >= 0`. If it is still `-1`, the registration did not complete — check the error output from `tap register`.

You can also verify your published registration:

```bash
tap identity resolve-self
```

---

## Summary of Taiko-Specific Points

| Concern | Taiko behavior |
|---|---|
| What to fund | USDC on Taiko |
| Gas payment | EIP-4337 + Servo Paymaster (no ETH needed) |
| IPFS upload provider | Tack x402, endpoint `https://tack-api-production.up.railway.app` |
| Provider selection | Automatic based on chain — no manual config needed |
| Override if needed | `--ipfs-provider tack` |

The `--chain taiko` flag on `tap init` is what sets all of this in motion. Everything else (IPFS provider selection, paymaster routing) is handled automatically.
