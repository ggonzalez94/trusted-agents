# Smoke Test Notes

Date: 2026-03-07

## Live-Validated

- Base mainnet `register` succeeded with `eip7702 + circle` and x402 IPFS upload.
- Base mainnet `register update` succeeded with `eip7702 + circle`.
- Base mainnet `register update` succeeded with `eip7702 + candide` after adding automatic USDC approval handling.
- Base mainnet `register update` no-change path succeeded.
- `identity show`, `identity resolve`, `identity resolve-self`, `balance`, `config show`, `invite create`, `invite list`, `contacts list`, and `conversations list` all succeeded in smoke runs.
- Full local verification passed:
  - `bun run typecheck`
  - `bun run test`

## Issues Fixed During Smoke

1. `tap register update` was inheriting the required options from `tap register`.
   - Fixed by turning `register` into a command group and normalizing `tap register ...` into `tap register create ...`.

2. Base public RPC rate limits could fail reads/writes mid-command.
   - Fixed by adding retry-hardened RPC transports and official Base/Base Sepolia preconf RPC fallbacks.

3. Circle permit metadata was being loaded twice in the same command.
   - This could spend x402 on upload and then fail on the second `nonces()` read.
   - Fixed by preflighting execution readiness and caching Circle permit metadata for one send.

4. Candide fallback was detected but not actually usable on a fresh address.
   - The paymaster required USDC allowance.
   - Fixed by prepending a USDC `approve()` call when allowance is below the fallback threshold.

5. Draining an account down to zero USDC is not straightforward on the Circle path.
   - Near-empty transfers can still consume the Circle paymaster fee even when the inner USDC transfer reverts.
   - This showed up while returning smoke-test funds.
   - A dedicated sweep helper should subtract estimated USDC gas overhead instead of attempting to transfer the full raw balance.

## Remaining Gaps

1. XMTP peer-to-peer was not live-smoked end-to-end.
   - Local tests passed, including SDK and transport tests.
   - A real connect/message smoke still needs a second registered/funded agent.

2. x402 is still EOA-signed.
   - This is fine for Base `eip7702` because the execution address and EOA are the same.
   - The separate-address `4337` top-up path was only covered by automated tests, not a live smoke.

3. Base still depends on public RPC infrastructure.
   - The preconf fallback fixed the observed `429` failures in this session.
   - Under heavier load, users may still need to override `chains.eip155:8453.rpc_url`.

4. The smoke agent still has a small Base USDC remainder.
   - After returning funds, the remaining balance was `0.012268 USDC`.
   - That remainder is effectively Circle/paymaster dust unless we implement a gas-aware sweep flow.
