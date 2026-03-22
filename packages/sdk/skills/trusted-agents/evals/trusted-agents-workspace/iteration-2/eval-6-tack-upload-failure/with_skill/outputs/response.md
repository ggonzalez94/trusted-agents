# Tack Upload Failure on Taiko

When your agent is on Taiko and `tap register` fails with a "Tack upload failed" error, the IPFS upload via the Tack x402 endpoint could not complete. Here is what to check and how to diagnose it.

## What is happening

On Taiko, `tap register` auto-selects Tack as the IPFS upload provider. Tack uses an x402 micropayment protocol: your wallet pays with USDC on Taiko mainnet to pin the registration file on IPFS. The full error message in the CLI is:

> IPFS upload via Tack failed: Tack upload failed (HTTP ...): ...
>
> Tack x402 uploads require USDC on Taiko mainnet (chain ID 167000).

## What to check

### 1. USDC balance on Taiko mainnet

The most common cause. Tack requires USDC on Taiko mainnet (chain ID 167000) to pay for the upload. Check your balance:

```bash
tap balance
```

Look at the USDC balance on Taiko. It must be non-zero. If you have no USDC on Taiko, fund your wallet address with USDC on Taiko mainnet before retrying.

### 2. The Tack API endpoint is reachable

The default Tack endpoint is `https://tack-api-production.up.railway.app`. If there is a network or service issue, the upload will fail with an HTTP error code in the message (e.g., HTTP 502, 503, or a connection error). Confirm the endpoint is reachable and check whether the error message includes an HTTP status code. A 5xx error or a connection failure indicates a transient service problem — wait and retry.

### 3. Whether a custom Tack API URL is configured incorrectly

If you have set `TAP_TACK_API_URL` in your environment or `ipfs.tackApiUrl` in your config, verify it is correct:

```bash
tap config show
```

Look for an `ipfs` section. If `tackApiUrl` is set, ensure it points to the correct Tack endpoint. You can also unset `TAP_TACK_API_URL` to fall back to the default.

### 4. Whether the IPFS provider was forced to something unexpected

If you passed `--ipfs-provider` explicitly, confirm it is set to `tack` (the correct value for Taiko) or `auto`. Passing `x402` would attempt a Pinata upload paying with Base mainnet USDC, which would fail for a different reason.

## How to fix or work around it

**Option A — Fund with Taiko USDC and retry** (recommended for Taiko agents)

Fund the wallet address shown by `tap identity show` with USDC on Taiko mainnet, then re-run:

```bash
tap register --name "YourAgent" --description "Your description" --capabilities "general-chat"
```

**Option B — Use a Pinata JWT instead**

If you have a Pinata account, you can bypass the x402 payment entirely:

```bash
tap register --name "YourAgent" --description "Your description" --capabilities "general-chat" --ipfs-provider pinata --pinata-jwt <your-pinata-jwt>
```

Or set the environment variable `TAP_PINATA_JWT=<your-token>` and omit the flag.

**Option C — Provide a pre-hosted URI**

If you can host the registration JSON file yourself at an `https://` URL, skip the IPFS upload entirely:

```bash
tap register --name "YourAgent" --description "Your description" --capabilities "general-chat" --uri https://your-host.example.com/agent-registration.json
```

The file must be a valid `eip-8004-registration-v1` JSON document. Use `tap identity resolve-self` after registration to verify it is reachable and valid.

## Summary of relevant commands

```bash
tap balance                   # Check USDC balance on Taiko
tap config show               # Check ipfs.provider and ipfs.tackApiUrl settings
tap identity show             # Confirm wallet address to fund
tap identity resolve-self     # Verify registration is reachable after a successful run
```
