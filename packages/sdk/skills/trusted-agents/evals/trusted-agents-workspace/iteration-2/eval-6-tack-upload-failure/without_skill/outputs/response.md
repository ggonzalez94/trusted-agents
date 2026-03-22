# Diagnosing a TAP Register IPFS Upload Failure on Taiko

When `tap register` fails with a "Tack upload failed" error during the IPFS upload step, there are several things to check. Here is a systematic approach:

## 1. Check Your Network / IPFS Gateway Connectivity

The registration process uploads your agent metadata to IPFS via an external gateway. The most common cause of upload failures is a network connectivity issue.

**What to check:**
- Can you reach the IPFS gateway? Try fetching a known IPFS resource to confirm basic connectivity.
- Is there a firewall, VPN, or proxy blocking outbound HTTPS requests?
- Are you behind a corporate network that restricts outbound connections?

## 2. Check Your Wallet / Payment Configuration

IPFS uploads via the TAP registration flow may use a paid upload path (x402 payments). The payment for IPFS upload uses **Base mainnet USDC**, even if your agent is registered on a different chain like Taiko.

**What to check:**
- Does your wallet have sufficient USDC on **Base mainnet** (not Taiko) to pay for the IPFS upload?
- Is your private key correctly configured and does it control the wallet address you expect?

Run a balance check on Base mainnet for the wallet associated with your agent's private key to confirm it has USDC.

## 3. Check Your Agent Identity / Data Directory

**What to check:**
- Is your `TAP_DATA_DIR` (or `--data-dir`) set correctly and pointing to the right agent identity?
- Does the identity key file exist at `<dataDir>/identity/agent.key`?
- Is the config file (`<dataDir>/config.yaml`) well-formed?

You can inspect your config with:
```bash
tap config show
# or with explicit data dir:
tap config show --data-dir <your-data-dir>
```

## 4. Check for a Cached CID

The register command caches IPFS content hashes at `<dataDir>/ipfs-cache.json`. If a previous upload partially succeeded, a stale cache entry might be causing issues.

**What to check:**
- Inspect `<dataDir>/ipfs-cache.json` and see if there is a cached CID.
- If a CID exists, the CLI will attempt to verify it via `HEAD https://ipfs.io/ipfs/<cid>` before reusing it. If that check fails (e.g. the content was never pinned), it will retry the upload.
- You can try deleting or clearing `ipfs-cache.json` to force a fresh upload attempt.

## 5. Retry the Registration

Once you have verified connectivity and your Base mainnet USDC balance, retry:

```bash
tap register
# or with explicit data dir:
tap register --data-dir <your-data-dir>
```

## 6. Check for Verbose / Debug Output

If the error message is not detailed enough, check if there is a verbose or debug flag available:

```bash
tap register --verbose
```

This may surface the underlying HTTP error (e.g. 402 Payment Required, 403 Forbidden, 500 Internal Server Error from the IPFS gateway) which will point you to the exact failure reason.

## Summary of Most Likely Causes

| Cause | Fix |
|---|---|
| No USDC on Base mainnet | Fund your wallet with Base mainnet USDC |
| Network/firewall blocking IPFS gateway | Check connectivity, disable VPN/proxy |
| Stale IPFS cache | Delete `<dataDir>/ipfs-cache.json` and retry |
| Wrong data directory / identity | Confirm `--data-dir` or `TAP_DATA_DIR` is set correctly |
| IPFS gateway temporary outage | Wait and retry |

Note: The chain your agent is registered on (Taiko in your case) does not affect the IPFS upload payment — that always goes through Base mainnet USDC regardless of your agent's target chain.
