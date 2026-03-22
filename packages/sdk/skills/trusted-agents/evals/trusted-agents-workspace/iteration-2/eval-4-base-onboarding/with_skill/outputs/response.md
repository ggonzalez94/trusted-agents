# Setting Up a New TAP Agent on Base Mainnet

You already have `tap` installed and 1 USDC on Base. Here is the complete onboarding walkthrough.

---

## Step 1: Create Your Wallet

Run:

```bash
tap init --chain base
```

This generates a fresh wallet and local config. The output will show your wallet address — **copy it**, you'll need it in the next step.

---

## Step 2: Fund the Wallet

Send your **1 USDC on Base** to the wallet address shown in the `tap init` output.

On Base, registration uses EIP-7702 + the Circle Paymaster, so you do **not** need ETH for gas — USDC covers everything.

Once you've sent the funds, confirm they arrived:

```bash
tap balance
```

You should see your USDC balance before continuing. ~0.50 USDC is needed for registration (IPFS upload + on-chain tx), so 1 USDC gives you a comfortable margin.

---

## Step 3: Register On-Chain

You'll need three pieces of information:

1. **Name** — a display name for your agent, e.g. `"MyAgent"`
2. **Description** — a short phrase describing what it does, e.g. `"General purpose assistant"`
3. **Capabilities** — public discovery labels. For a general agent, `general-chat` is a good default. If it handles payments too, use `transfer,general-chat`.

Then run (substituting your own values):

```bash
tap register --name "MyAgent" --description "General purpose assistant" --capabilities "general-chat"
```

This uploads your agent's metadata to IPFS and mints an ERC-8004 token on Base mainnet. When it completes, your agent has a verifiable on-chain identity.

You can verify it registered correctly:

```bash
tap identity show
```

You should see `agent_id >= 0`. If `agent_id` is still `-1`, registration did not complete — check your balance with `tap balance` and retry.

---

## You're Done with Onboarding

At this point your agent is live on Base mainnet. The next steps depend on what you want to do:

- **Connect to another agent:** `tap invite create` (share the URL with the other agent, or ask for theirs and run `tap connect "<invite-url>" --yes`)
- **Check contacts:** `tap contacts list`
- **Sync pending messages:** `tap message sync`
- **Check your config:** `tap config show`

---

## Common Issues

| Problem | Fix |
|---|---|
| `agent_id` is still `-1` after `tap register` | Registration failed — check `tap balance` and retry |
| `Insufficient funds` | Make sure USDC arrived at your wallet address before registering |
| `Invalid chain format` | Use `base` (not `base-mainnet` or a chain ID) |
