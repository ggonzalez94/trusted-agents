# OWS Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw private key management with Open Wallet Standard (OWS) for all signing operations, remove testnet chains, and update docs/skills.

**Architecture:** Introduce a `SigningProvider` interface in core with a single `OwsSigningProvider` implementation backed by the `@open-wallet-standard/core` SDK. All code paths that currently use `privateKeyToAccount(config.privateKey)` are rewired to go through this interface. A custom viem account adapter bridges `SigningProvider` into viem's `WalletClient` for execution paths.

**Tech Stack:** TypeScript, viem, `@open-wallet-standard/core` (NAPI bindings), `@xmtp/node-sdk`, bun test

**Spec:** `docs/superpowers/specs/2026-03-25-ows-migration-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `packages/core/src/signing/provider.ts` | `SigningProvider` interface + types |
| `packages/core/src/signing/ows-provider.ts` | `OwsSigningProvider` — wraps OWS SDK |
| `packages/core/src/signing/viem-account.ts` | `createSigningProviderViemAccount()` — viem adapter |
| `packages/core/src/signing/index.ts` | Barrel export |
| `packages/core/test/signing/ows-provider.test.ts` | Unit tests for `OwsSigningProvider` |
| `packages/core/test/signing/viem-account.test.ts` | Unit tests for viem adapter |
| `packages/cli/src/commands/migrate-wallet.ts` | `tap migrate-wallet` command |
| `packages/cli/src/lib/ows.ts` | OWS CLI helpers (detect, install, wallet/policy/key ops) |
| `packages/cli/test/commands/migrate-wallet.test.ts` | Migration command tests |

### Modified files (by task)
See individual tasks below for exact file paths and line ranges.

---

## Task 1: Testnet Removal

Remove Base Sepolia and Taiko Hoodi from the codebase. This is done first because it simplifies every subsequent task (fewer chains, no `xmtpEnv` branching).

**Files:**
- Modify: `packages/core/src/config/defaults.ts`
- Modify: `packages/core/src/config/load.ts`
- Modify: `packages/core/src/config/types.ts`
- Modify: `packages/core/src/common/viem.ts`
- Modify: `packages/core/src/runtime/assets.ts`
- Modify: `packages/core/src/runtime/default-context.ts`
- Modify: `packages/core/src/transport/xmtp-types.ts`
- Modify: `packages/core/src/transport/xmtp.ts`
- Modify: `packages/cli/src/lib/chains.ts`
- Modify: `packages/cli/src/lib/wallet.ts`
- Modify: `packages/cli/src/lib/ipfs.ts`
- Modify: `packages/cli/src/commands/init.ts`

- [ ] **Step 1: Remove testnet chain configs from `packages/core/src/config/defaults.ts`**

Delete the `BASE_SEPOLIA` constant (lines 13-22). Remove the `"eip155:84532"` entry from `DEFAULT_CHAINS` (line 26). Only `BASE_MAINNET` and `"eip155:8453"` remain.

- [ ] **Step 2: Update `packages/core/src/config/load.ts` — default chain + testnet entries**

Change the default chain fallback on line 101 from `"eip155:84532"` to `"eip155:8453"`. In `getDefaultExecutionModeForChain()` (line 58), remove `"base-sepolia"` and `"eip155:84532"` from the condition array.

- [ ] **Step 3: Remove `xmtpEnv` from `TrustedAgentsConfig` type**

In `packages/core/src/config/types.ts`, remove the `xmtpEnv?: "dev" | "production" | "local"` field (line 33). Remove `env` from `XmtpTransportConfig` in `packages/core/src/transport/xmtp-types.ts` (line 6). Update `packages/core/src/config/defaults.ts` — remove `xmtpEnv: "production"` line (line 35). Update `packages/core/src/config/load.ts` — remove `xmtpEnv: yaml?.xmtp?.env ?? DEFAULT_CONFIG.xmtpEnv` from the return object (line 139). Remove `env` from `StoredYamlConfig.xmtp` interface (line 25).

- [ ] **Step 4: Remove testnet chains from `packages/core/src/common/viem.ts`**

Remove `baseSepolia` and `taikoHoodi` from the import on line 4. Remove `84532: baseSepolia` and `167013: taikoHoodi` from `VIEM_CHAINS` (lines 9, 11). Remove the `84532` entry from `RPC_FALLBACK_URLS` (line 24).

- [ ] **Step 5: Remove testnet USDC from `packages/core/src/runtime/assets.ts`**

Remove the `"eip155:167013"` USDC config entry.

- [ ] **Step 5b: Remove testnet from `packages/core/src/runtime/execution/policy.ts`**

In `isBaseChain()`, remove the `chainConfig.chainId === 84532` check.

- [ ] **Step 5c: Remove testnet from `packages/core/src/runtime/execution/catalog.ts`**

Remove the `"eip155:84532"` entry from `ZERO_CONFIG_PROVIDER_CATALOG`.

- [ ] **Step 6: Remove `env` usage from `packages/core/src/runtime/default-context.ts`**

On line 52, remove `env: config.xmtpEnv` from the `XmtpTransport` constructor config. The XMTP transport will default to `production`.

- [ ] **Step 7: Remove `env` usage from `packages/core/src/transport/xmtp.ts`**

Find where `this.config.env` is used and replace with hardcoded `"production"`. Remove the `env` property from any runtime config reading.

- [ ] **Step 8: Remove testnet aliases from `packages/cli/src/lib/chains.ts`**

Remove `base-sepolia` and `taiko-hoodi` entries from the `ALL_CHAINS` map and alias list.

- [ ] **Step 9: Remove testnet viem mappings from `packages/cli/src/lib/wallet.ts`**

Remove any chain mappings for chain IDs 84532 and 167013.

- [ ] **Step 10: Remove testnet from `packages/cli/src/lib/ipfs.ts`**

Remove `"eip155:167013"` from the `TAIKO_CHAINS` set (line 18).

- [ ] **Step 11: Remove testnet branching from `packages/cli/src/commands/init.ts`**

Remove `isTestnet` / `xmtpEnv` logic (lines 72-73). Remove `xmtp: { env: xmtpEnv }` from config file writing (line 95). The init command no longer asks about or branches on testnet.

- [ ] **Step 12: Run typecheck and tests**

```bash
bun run typecheck && bun run test
```

Fix any compilation errors from removed types/fields. Expect some test updates where tests reference testnet chains.

- [ ] **Step 11b: Remove testnet from `packages/cli/src/commands/config-show.ts`**

Remove `xmtp_env: config.xmtpEnv ?? "production"` display line.

- [ ] **Step 11c: Remove testnet XMTP env references from `packages/cli/src/commands/config-set.ts`**

Remove `xmtp.env`-related alias entries and comments.

- [ ] **Step 11d: Remove testnet smoke script `packages/cli/scripts/live-smoke-top-up.ts`**

Delete this file (or update to mainnet only — it imports `baseSepolia` from `viem/chains`).

- [ ] **Step 12: Run typecheck and tests**

```bash
bun run typecheck && bun run test
```

Fix any compilation errors from removed types/fields. Update any test files that reference testnet chains (84532, 167013, `base-sepolia`, `taiko-hoodi`).

- [ ] **Step 13: Commit**

```bash
git add packages/core/ packages/cli/
git commit -m "refactor: remove testnet chains (Base Sepolia, Taiko Hoodi)"
```

---

## Task 2: `SigningProvider` Interface + Viem Adapter

Create the core signing abstraction and the viem account adapter. No OWS dependency yet — just the interface and adapter.

**Files:**
- Create: `packages/core/src/signing/provider.ts`
- Create: `packages/core/src/signing/viem-account.ts`
- Create: `packages/core/src/signing/index.ts`
- Create: `packages/core/test/signing/viem-account.test.ts`

- [ ] **Step 1: Write failing test for viem account adapter**

Create `packages/core/test/signing/viem-account.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { SigningProvider } from "../../src/signing/provider.js";
import { createSigningProviderViemAccount } from "../../src/signing/viem-account.js";

function createMockProvider(address: `0x${string}` = "0xabcdef0123456789abcdef0123456789abcdef01"): SigningProvider {
  return {
    getAddress: async () => address,
    signMessage: async () => "0xdeadbeef" as `0x${string}`,
    signTypedData: async () => "0xdeadbeef" as `0x${string}`,
    signTransaction: async () => "0xdeadbeef" as `0x${string}`,
    signAuthorization: async () => ({
      contractAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      chainId: 8453,
      nonce: 0,
      r: "0x0" as `0x${string}`,
      s: "0x0" as `0x${string}`,
      v: 27n,
    }),
  };
}

describe("createSigningProviderViemAccount", () => {
  it("returns account with correct address", async () => {
    const address = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;
    const provider = createMockProvider(address);
    const account = await createSigningProviderViemAccount(provider);
    expect(account.address).toBe(address);
  });

  it("delegates signMessage to provider", async () => {
    const provider = createMockProvider();
    const account = await createSigningProviderViemAccount(provider);
    const sig = await account.signMessage({ message: "hello" });
    expect(sig).toBe("0xdeadbeef");
  });

  it("delegates signTransaction to provider", async () => {
    const provider = createMockProvider();
    const account = await createSigningProviderViemAccount(provider);
    const sig = await account.signTransaction({
      to: "0x0000000000000000000000000000000000000000",
      value: 0n,
    });
    expect(sig).toBe("0xdeadbeef");
  });

  it("delegates signTypedData to provider", async () => {
    const provider = createMockProvider();
    const account = await createSigningProviderViemAccount(provider);
    const sig = await account.signTypedData({
      domain: {},
      types: { EIP712Domain: [] },
      primaryType: "EIP712Domain",
      message: {},
    });
    expect(sig).toBe("0xdeadbeef");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && bun test test/signing/viem-account.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Create `packages/core/src/signing/provider.ts`**

```ts
import type { Hex, SignableMessage, TransactionSerializable } from "viem";

export interface SignTypedDataParameters {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignedAuthorization {
  contractAddress: `0x${string}`;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  v: bigint;
}

export interface AuthorizationParameters {
  contractAddress: `0x${string}`;
  chainId?: number;
  nonce?: number;
}

export interface SigningProvider {
  getAddress(): Promise<`0x${string}`>;
  signMessage(message: SignableMessage): Promise<Hex>;
  signTypedData(params: SignTypedDataParameters): Promise<Hex>;
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
  signAuthorization(params: AuthorizationParameters): Promise<SignedAuthorization>;
}
```

- [ ] **Step 4: Create `packages/core/src/signing/viem-account.ts`**

```ts
import type { LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import type { SigningProvider } from "./provider.js";

export async function createSigningProviderViemAccount(
  provider: SigningProvider,
): Promise<LocalAccount> {
  const address = await provider.getAddress();
  return toAccount({
    address,
    signMessage: async ({ message }) => provider.signMessage(message),
    signTransaction: async (tx) => provider.signTransaction(tx),
    signTypedData: async (typedData) =>
      provider.signTypedData({
        domain: typedData.domain as Record<string, unknown>,
        types: typedData.types as Record<string, unknown>,
        primaryType: typedData.primaryType as string,
        message: typedData.message as Record<string, unknown>,
      }),
  });
}
```

Note: Verify `toAccount` API against the project's pinned viem version. If viem uses a different import path, adjust accordingly.

- [ ] **Step 5: Create `packages/core/src/signing/index.ts`**

```ts
export type {
  AuthorizationParameters,
  SignedAuthorization,
  SigningProvider,
  SignTypedDataParameters,
} from "./provider.js";
export { createSigningProviderViemAccount } from "./viem-account.js";
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd packages/core && bun test test/signing/viem-account.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run full typecheck**

```bash
bun run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/signing/ packages/core/test/signing/
git commit -m "feat(core): add SigningProvider interface and viem account adapter"
```

---

## Task 3: `OwsSigningProvider` Implementation

Add the `@open-wallet-standard/core` dependency and implement the OWS-backed signing provider.

**Files:**
- Modify: `packages/core/package.json`
- Create: `packages/core/src/signing/ows-provider.ts`
- Create: `packages/core/test/signing/ows-provider.test.ts`
- Modify: `packages/core/src/signing/index.ts`

- [ ] **Step 1: Add `@open-wallet-standard/core` dependency**

```bash
cd packages/core && bun add @open-wallet-standard/core
```

- [ ] **Step 2: Write failing test for `OwsSigningProvider`**

Create `packages/core/test/signing/ows-provider.test.ts`. This test requires OWS to be installed and will create a throwaway wallet. If OWS is not available, skip with a clear message.

```ts
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { OwsSigningProvider } from "../../src/signing/ows-provider.js";

const WALLET_NAME = `tap-test-${Date.now()}`;
let apiKey: string;
let expectedAddress: string;

describe("OwsSigningProvider", () => {
  beforeAll(() => {
    try {
      execSync("ows --version", { stdio: "pipe" });
    } catch {
      throw new Error("OWS CLI not installed — run: curl -fsSL https://docs.openwallet.sh/install.sh | bash");
    }

    // Create test wallet
    const createOutput = execSync(`ows wallet create --name "${WALLET_NAME}"`, { encoding: "utf-8" });
    // Extract EVM address from output
    const addressMatch = createOutput.match(/eip155:\d+\s+(0x[0-9a-fA-F]{40})/);
    expectedAddress = addressMatch?.[1] ?? "";

    // Create permissive policy
    const policyJson = JSON.stringify({
      id: `test-${Date.now()}`,
      name: "test-all-chains",
      version: 1,
      created_at: new Date().toISOString(),
      rules: [{ type: "allowed_chains", chain_ids: ["eip155:8453", "eip155:167000"] }],
      action: "deny",
    });
    execSync(`echo '${policyJson}' | ows policy create --file -`, { stdio: "pipe" });

    // Create API key
    const keyOutput = execSync(
      `ows key create --name "test-key-${Date.now()}" --wallet "${WALLET_NAME}" --policy "test-${Date.now()}"`,
      { encoding: "utf-8" },
    );
    const keyMatch = keyOutput.match(/(ows_key_[a-zA-Z0-9]+)/);
    apiKey = keyMatch?.[1] ?? "";
  });

  afterAll(() => {
    try {
      execSync(`ows wallet delete --name "${WALLET_NAME}" --confirm`, { stdio: "pipe" });
    } catch { /* cleanup best-effort */ }
  });

  it("getAddress returns the EVM address", async () => {
    const provider = new OwsSigningProvider(WALLET_NAME, "eip155:8453", apiKey);
    const address = await provider.getAddress();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("signMessage returns a valid hex signature", async () => {
    const provider = new OwsSigningProvider(WALLET_NAME, "eip155:8453", apiKey);
    const sig = await provider.signMessage("hello world");
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("signMessage is deterministic (RFC 6979)", async () => {
    const provider = new OwsSigningProvider(WALLET_NAME, "eip155:8453", apiKey);
    const sig1 = await provider.signMessage("deterministic-test");
    const sig2 = await provider.signMessage("deterministic-test");
    expect(sig1).toBe(sig2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/core && bun test test/signing/ows-provider.test.ts
```

Expected: FAIL — `OwsSigningProvider` not found.

- [ ] **Step 4: Implement `packages/core/src/signing/ows-provider.ts`**

Implement `OwsSigningProvider` wrapping `@open-wallet-standard/core` SDK. Map each method to the corresponding OWS SDK function, passing `walletName`, `chain`, and `apiKey`. For `signTypedData`, compute the EIP-712 hash with viem's `hashTypedData` and pass to OWS `signMessage`. For `signAuthorization`, encode the authorization struct and sign it.

Consult the OWS Node.js SDK reference (`references/sdk-node.md` in the open-wallet skill) for exact function signatures — do **not** guess the API.

- [ ] **Step 5: Export from `packages/core/src/signing/index.ts`**

Add `export { OwsSigningProvider } from "./ows-provider.js";`

- [ ] **Step 6: Run test to verify it passes**

```bash
cd packages/core && bun test test/signing/ows-provider.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run full typecheck and test suite**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/signing/ packages/core/test/signing/ packages/core/package.json
git commit -m "feat(core): add OwsSigningProvider backed by @open-wallet-standard/core"
```

---

## Task 4: Core Migration — Config, Transport, Invite, Service, Execution (Atomic)

This is the big atomic task. It changes the config type, wires `SigningProvider` through all core modules, and updates the execution layer. These changes are done together because removing `privateKey` from the config type cascades everywhere — doing it piecemeal creates un-compilable intermediate states.

**Files:**
- Modify: `packages/core/src/config/types.ts`
- Modify: `packages/core/src/config/schema.ts`
- Modify: `packages/core/src/config/load.ts`
- Modify: `packages/core/src/config/defaults.ts`
- Modify: `packages/core/src/transport/xmtp-types.ts`
- Modify: `packages/core/src/transport/xmtp-signer.ts`
- Modify: `packages/core/src/transport/xmtp.ts`
- Modify: `packages/core/src/connection/invite.ts`
- Modify: `packages/core/src/runtime/service.ts`
- Modify: `packages/core/src/runtime/default-context.ts`
- Modify: `packages/core/src/common/viem.ts`
- Modify: `packages/core/src/runtime/execution/types.ts`
- Modify: `packages/core/src/runtime/execution.ts`
- Modify: `packages/core/src/runtime/transfer-executor.ts`

- [ ] **Step 1: Write config schema test**

Add a test verifying the new OWS validation rules in config schema (e.g., `ows.apiKey` must start with `ows_key_`, `ows.wallet` must be non-empty). Add to existing config tests or create `packages/core/test/config/schema.test.ts`.

- [ ] **Step 2: Update `TrustedAgentsConfig` type**

In `packages/core/src/config/types.ts`: remove `privateKey: \`0x${string}\`` (line 27), remove `xmtpEnv` (already gone from Task 1, verify). Add `ows: { wallet: string; apiKey: string; }`.

- [ ] **Step 3: Update config defaults**

In `packages/core/src/config/defaults.ts`: change `Omit<..., "agentId" | "chain" | "privateKey">` to `Omit<..., "agentId" | "chain" | "ows">`.

- [ ] **Step 4: Update config schema validator**

In `packages/core/src/config/schema.ts`: change `Pick` from `"privateKey"` to `"ows"`. Remove `privateKey` validation block. Add OWS validation:
```ts
if (!partial.ows?.wallet || typeof partial.ows.wallet !== "string") {
  throw new ConfigError("ows.wallet is required and must be a non-empty string");
}
if (!partial.ows?.apiKey?.startsWith("ows_key_")) {
  throw new ConfigError("ows.apiKey is required and must start with 'ows_key_'");
}
```

- [ ] **Step 5: Update config loader**

In `packages/core/src/config/load.ts`: add `ows` to `StoredYamlConfig`. Remove `privateKey` from `LoadTrustedAgentConfigOptions`, add `owsWallet?` and `owsApiKey?`. Remove `loadKeyfile()` function and `KEYFILE_NAME` constant. Replace `privateKey` in return object with `ows: { wallet, apiKey }`.

- [ ] **Step 6: Update `XmtpTransportConfig`**

In `packages/core/src/transport/xmtp-types.ts`: replace `privateKey` with `signingProvider: SigningProvider`.

- [ ] **Step 7: Update `createXmtpSigner`**

In `packages/core/src/transport/xmtp-signer.ts`: change to `async function createXmtpSigner(provider: SigningProvider)`. Use `provider.getAddress()` and `provider.signMessage()`.

- [ ] **Step 8: Update `XmtpTransport`**

In `packages/core/src/transport/xmtp.ts`: use `this.config.signingProvider` for signer creation. Hardcode `"production"` for XMTP env.

- [ ] **Step 9: Update `generateInvite`**

In `packages/core/src/connection/invite.ts`: change `privateKey` param to `signingProvider: SigningProvider`. Use `signingProvider.signMessage({ raw: toBytes(message) })`.

- [ ] **Step 10: Update `TapMessagingService`**

In `packages/core/src/runtime/service.ts`: add `signingProvider: SigningProvider` to constructor. Use `await signingProvider.getAddress()` for `localAgentAddress`. Store provider as instance field. If constructor can't be async, use a static factory method `static async create(...)` or move address derivation to `start()`.

- [ ] **Step 11: Update `buildDefaultTapRuntimeContext`**

In `packages/core/src/runtime/default-context.ts`: add `signingProvider` to options (required). Pass to `XmtpTransport` config and return in context.

- [ ] **Step 12: Refactor `buildChainWalletClient`**

In `packages/core/src/common/viem.ts`: change signature to `buildChainWalletClient(account: LocalAccount, chainConfig)`. Remove `privateKeyToAccount` usage.

- [ ] **Step 13: Update `BaseExecutionContext` type**

In `packages/core/src/runtime/execution/types.ts`: change `owner` to `LocalAccount`, `walletClient` to `WalletClient`. Remove `privateKeyToAccount` and `buildWalletClient` type imports.

- [ ] **Step 14: Update `resolveExecutionContext` and public execution functions**

In `packages/core/src/runtime/execution.ts`: add `SigningProvider` param to `resolveExecutionContext`, `getExecutionPreview`, `ensureExecutionReady`, `createExecutionEvmSigner`, `executeContractCalls`. Use `createSigningProviderViemAccount(provider)` instead of `privateKeyToAccount`. Pass `owner` to `buildWalletClient`.

- [ ] **Step 15: Update `transfer-executor.ts`**

In `packages/core/src/runtime/transfer-executor.ts`: update `executeOnchainTransfer` to accept `SigningProvider` and pass it to `executeContractCalls`.

- [ ] **Step 16: Run typecheck — core should compile**

```bash
cd packages/core && bun run typecheck 2>&1 | head -50
```

Remaining errors should only be in CLI and OpenClaw plugin (downstream consumers). Verify `servo.ts` compiles without changes (it uses `context.owner` which is now the viem adapter).

- [ ] **Step 17: Run config schema test**

```bash
cd packages/core && bun test test/config/schema.test.ts
```

- [ ] **Step 18: Commit**

```bash
git add packages/core/
git commit -m "refactor(core): replace privateKey with SigningProvider across config, transport, execution"
```

---

## Task 5: CLI Wiring — Context, Config Loader, Commands

Wire `SigningProvider` through all CLI commands that use `config.privateKey`.

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/lib/context.ts`
- Modify: `packages/cli/src/lib/config-loader.ts`
- Modify: `packages/cli/src/lib/execution.ts`
- Modify: `packages/cli/src/lib/tap-service.ts`
- Modify: `packages/cli/src/lib/ipfs.ts`
- Modify: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/commands/register.ts`
- Modify: `packages/cli/src/commands/remove.ts`
- Modify: `packages/cli/src/commands/transfer.ts`
- Modify: `packages/cli/src/commands/balance.ts`
- Modify: `packages/cli/src/commands/identity-show.ts`
- Modify: `packages/cli/src/commands/message-request-funds.ts`
- Modify: `packages/cli/src/commands/invite-create.ts`
- Modify: `packages/cli/src/commands/config-show.ts`
- Modify: `packages/cli/src/commands/config-set.ts`
- Delete: `packages/cli/src/lib/keyfile.ts`

- [ ] **Step 1: Update CLI config loader**

In `packages/cli/src/lib/config-loader.ts`:
- Remove `TAP_PRIVATE_KEY` env var reading
- Add `TAP_OWS_WALLET` and `TAP_OWS_API_KEY` env var reading
- Pass `owsWallet` and `owsApiKey` to `loadTrustedAgentConfigFromDataDir()` options instead of `privateKey`

- [ ] **Step 2: Update CLI context**

In `packages/cli/src/lib/context.ts`:
- After loading config, construct `OwsSigningProvider` from `config.ows`
- Attach `signingProvider` to the context object
- Pass it to `TapMessagingService`, `buildDefaultTapRuntimeContext`, etc.

- [ ] **Step 3: Update `packages/cli/src/cli.ts`**

Remove `--private-key` flag from the `init` command. Remove any other `--private-key` global flags.

- [ ] **Step 4: Update execution wrapper and tap-service**

In `packages/cli/src/lib/execution.ts`: update wrappers that call core execution functions to pass `signingProvider` through.
In `packages/cli/src/lib/tap-service.ts`: update `executeOnchainTransfer` calls in hooks to pass `signingProvider`.

- [ ] **Step 5: Update address-only commands**

For each of these commands, replace `privateKeyToAccount(config.privateKey).address` with `await context.signingProvider.getAddress()`:
- `packages/cli/src/commands/balance.ts`
- `packages/cli/src/commands/identity-show.ts`
- `packages/cli/src/commands/message-request-funds.ts`

- [ ] **Step 6: Update `invite-create.ts`**

Pass `context.signingProvider` to `generateInvite()` instead of `config.privateKey`.

- [ ] **Step 7: Update `register.ts`**

This file has 6+ `privateKey` usage sites. For each:
- Replace `privateKeyToAccount(config.privateKey)` with `await context.signingProvider.getAddress()`
- Replace `config.privateKey` passed to helpers with `context.signingProvider`
- Update `resolveAgentURI` internal function signature

- [ ] **Step 8: Update `remove.ts`**

Replace `privateKeyToAccount()` and `buildWalletClient()` calls with `context.signingProvider` and `createSigningProviderViemAccount()`.

- [ ] **Step 9: Update `transfer.ts`**

Pass `context.signingProvider` through to `executeOnchainTransfer`.

- [ ] **Step 10: Update `ipfs.ts` x402 signing**

Change `uploadToIpfsX402` signature: replace `privateKey` param with `SigningProvider`. Create viem account via `createSigningProviderViemAccount()` then pass to `toClientEvmSigner()`.

- [ ] **Step 11: Update `config-show.ts`**

Replace `private_key: "***redacted***"` display with OWS wallet/key display. Remove `xmtp_env` display.

- [ ] **Step 12: Update `config-set.ts`**

Remove `xmtp.env`-related alias entries and comments. Update any `privateKey` references.

- [ ] **Step 13: Delete `packages/cli/src/lib/keyfile.ts`**

Remove the file entirely. Remove any imports of `generateKeyfile`, `importKeyfile`, `loadKeyfile` from other files (primarily `init.ts`).

- [ ] **Step 14: Run typecheck and tests**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 15: Commit**

```bash
git add packages/cli/
git commit -m "refactor(cli): wire SigningProvider through all CLI commands"
```

---

## Task 6: OpenClaw Plugin Wiring

Wire `SigningProvider` through the OpenClaw plugin.

**Files:**
- Modify: `packages/openclaw-plugin/src/registry.ts`

- [ ] **Step 1: Update plugin registry**

In `packages/openclaw-plugin/src/registry.ts`:
- After loading config via `loadTrustedAgentConfigFromDataDir()`, construct `OwsSigningProvider` from `runtime.config.ows`
- Store as `runtime.signingProvider`
- Replace `privateKey: runtime.config.privateKey` (line 216) with `signingProvider: runtime.signingProvider`
- Replace `privateKeyToAccount(runtime.config.privateKey).address` (line 298) with `await runtime.signingProvider.getAddress()`
- Pass `signingProvider` to `TapMessagingService` constructor

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

At this point, the full codebase should compile with zero `privateKey` references remaining (except in tests and migration code).

- [ ] **Step 3: Verify no remaining `config.privateKey` references**

```bash
grep -r "config\.privateKey\|config\.private_key" packages/ --include="*.ts" | grep -v node_modules | grep -v ".test." | grep -v "migrate-wallet"
```

Expected: zero results.

- [ ] **Step 4: Commit**

```bash
git add packages/openclaw-plugin/
git commit -m "refactor(openclaw): wire SigningProvider through plugin registry"
```

---

## Task 7: OWS CLI Helpers + `tap init` Rewrite

Create OWS CLI helper functions and rewrite `tap init` to use OWS onboarding.

**Files:**
- Create: `packages/cli/src/lib/ows.ts`
- Modify: `packages/cli/src/commands/init.ts`

- [ ] **Step 1: Create OWS CLI helpers**

Create `packages/cli/src/lib/ows.ts` with functions for:
- `isOwsInstalled(): boolean` — checks if `ows` is on PATH
- `installOws(): Promise<void>` — runs the install script
- `ensureOwsInstalled(): Promise<void>` — checks + prompts + installs
- `listOwsWallets(): Promise<string[]>` — parses `ows wallet list` output
- `createOwsWallet(name: string): Promise<{ address: string }>` — creates wallet
- `listOwsPolicies(): Promise<Array<{ id: string; name: string }>>` — parses `ows policy list`
- `createOwsPolicy(opts: { chains: string[]; expiresAt: string }): Promise<string>` — creates policy, returns policy ID
- `createOwsApiKey(opts: { name: string; wallet: string; policy: string }): Promise<string>` — creates key, returns `ows_key_...`
- `deriveXmtpDbEncryptionKey(provider: SigningProvider): Promise<\`0x${string}\`>` — signs deterministic message, returns keccak256 hash

All functions shell out to `ows` CLI via `execSync`/`execAsync` with proper error handling.

- [ ] **Step 2: Rewrite `tap init`**

In `packages/cli/src/commands/init.ts`, replace the keyfile generation flow with:
1. `ensureOwsInstalled()`
2. Prompt: create new wallet or use existing
3. Policy setup (list existing, offer reuse, or create new)
4. Create API key
5. Write `config.yaml` with `ows` block
6. Derive and persist `xmtp.dbEncryptionKey`
7. Proceed to registration

Remove all imports from `keyfile.ts`. Remove `isTestnet`/`xmtpEnv` logic.

- [ ] **Step 3: Run typecheck and test**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/ows.ts packages/cli/src/commands/init.ts
git commit -m "feat(cli): rewrite tap init with OWS onboarding flow"
```

---

## Task 8: `tap migrate-wallet` Command

Create the migration command for existing agents.

**Files:**
- Create: `packages/cli/src/commands/migrate-wallet.ts`
- Create: `packages/cli/test/commands/migrate-wallet.test.ts`
- Modify: `packages/cli/src/cli.ts` (register the command)

- [ ] **Step 1: Write failing test for migration**

Create `packages/cli/test/commands/migrate-wallet.test.ts` that:
- Creates a legacy data dir with `config.yaml` (containing `agent_id`, `chain`) and `identity/agent.key`
- Runs the migration logic
- Verifies: OWS wallet created, config.yaml updated with `ows` block, `xmtp.dbEncryptionKey` persisted, `identity/agent.key` deleted, address matches

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/cli && bun test test/commands/migrate-wallet.test.ts
```

- [ ] **Step 3: Implement `tap migrate-wallet`**

Create `packages/cli/src/commands/migrate-wallet.ts` following the spec's migration flow (section 8):
1. Verify OWS installed (auto-install)
2. Read existing `identity/agent.key`
3. Compute XMTP DB encryption key from old key
4. Import key into OWS
5. Policy setup
6. Create API key
7. Update config.yaml
8. Verify address match
9. Delete `identity/agent.key`

- [ ] **Step 4: Register command in `packages/cli/src/cli.ts`**

Add the `migrate-wallet` subcommand.

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/cli && bun test test/commands/migrate-wallet.test.ts
```

- [ ] **Step 6: Run full test suite**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/migrate-wallet.ts packages/cli/test/commands/migrate-wallet.test.ts packages/cli/src/cli.ts
git commit -m "feat(cli): add tap migrate-wallet command for OWS migration"
```

---

## Task 9: Test Infrastructure Migration

Update shared test fixtures and helpers that reference `privateKey` or testnet chains. This must be done before the E2E test update.

**Files:**
- Modify: `packages/core/test/fixtures/test-keys.ts` (or similar)
- Modify: `packages/core/test/helpers/test-agent.ts` (or similar)
- Modify: `packages/cli/test/helpers/loopback-runtime.ts`
- Modify: All unit test files referencing `config.privateKey`

- [ ] **Step 1: Update shared test fixtures**

In `packages/core/test/fixtures/` and `packages/core/test/helpers/`: replace `privateKey` fields with mock `SigningProvider`. Create a `createMockSigningProvider()` helper that returns a `SigningProvider` with canned signatures (reuse the pattern from Task 2's viem-account test).

- [ ] **Step 2: Update CLI test helpers**

In `packages/cli/test/helpers/loopback-runtime.ts`: update `TestAgentFixture` to use `SigningProvider` instead of `privateKey`. Replace `privateKeyToAccount(fixture.privateKey)` with `provider.getAddress()`.

- [ ] **Step 3: Grep and fix remaining test files**

```bash
grep -r "privateKey\|private_key\|84532\|167013\|base-sepolia\|taiko-hoodi\|xmtpEnv\|baseSepolia\|taikoHoodi" packages/*/test/ --include="*.ts" -l | grep -v node_modules
```

For each file: update to use mock `SigningProvider` and mainnet chains.

- [ ] **Step 4: Run full test suite**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/ packages/cli/test/
git commit -m "test: migrate test infrastructure to SigningProvider and mainnet chains"
```

---

## Task 10: E2E Test Update

Update the two-agent E2E flow test for OWS wallets and new config shape.

**Files:**
- Modify: `packages/cli/test/e2e-two-agent-flow.test.ts`

- [ ] **Step 1: Update test setup**

Replace the raw key generation with OWS wallet creation:
- Create two OWS test wallets with permissive policies
- Create API keys for each
- Write config.yaml with `ows` block instead of `identity/agent.key`

- [ ] **Step 2: Update config references**

Replace any `config.privateKey` references with `config.ows` structure. Remove testnet chain references.

- [ ] **Step 3: Run the E2E test**

```bash
cd packages/cli && bun test test/e2e-two-agent-flow.test.ts
```

- [ ] **Step 4: Fix any failures and re-run**

- [ ] **Step 5: Run full test suite**

```bash
bun run typecheck && bun run lint && bun run test
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/test/e2e-two-agent-flow.test.ts
git commit -m "test(cli): update E2E two-agent flow for OWS wallets"
```

---

## Task 11: Documentation Updates

Update CLAUDE.md and other docs to reflect OWS migration.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `LIVE_SMOKE_RUNBOOK.md`

- [ ] **Step 1: Update CLAUDE.md**

- Section "Non-Obvious Behavior" #1: Replace "single private key" with OWS wallet + API token description
- Section "Non-Obvious Behavior" #2: Update XMTP DB encryption key derivation (signed-message + migration persistence)
- Section "Config lives inside data-dir": Update data-dir tree — remove `identity/agent.key`, add `ows` block in config.yaml
- Section "Chain support": Remove testnet references
- Remove `TAP_PRIVATE_KEY` from env var documentation
- Update "Build/Test Commands" with OWS CI setup note

- [ ] **Step 2: Update `LIVE_SMOKE_RUNBOOK.md`**

Remove testnet setup steps. Add OWS wallet setup to the prerequisites.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md LIVE_SMOKE_RUNBOOK.md
git commit -m "docs: update CLAUDE.md and runbook for OWS migration"
```

---

## Task 12: Skill Updates

Update the TAP skill using the skill-creator.

**Files:**
- Modify: `skills/trusted-agents/SKILL.md`

- [ ] **Step 1: Invoke skill-creator**

Use `@skill-creator` to update `skills/trusted-agents/SKILL.md`:
- Update `tap init` docs with OWS onboarding flow
- Add `tap migrate-wallet` command documentation
- Remove testnet chain references
- Update config docs: `ows` block instead of `agent.key`
- Remove raw private key management references
- Update troubleshooting for OWS errors

- [ ] **Step 2: Verify skill content**

Read the updated skill file and verify it's accurate and complete.

- [ ] **Step 3: Commit**

```bash
git add skills/trusted-agents/
git commit -m "docs(skill): update TAP skill for OWS migration"
```

---

## Task 13: Final Verification

Run the full suite and verify no regressions.

- [ ] **Step 1: Full lint, typecheck, and test**

```bash
bun run lint && bun run typecheck && bun run test
```

- [ ] **Step 2: Grep for any remaining raw key references**

```bash
grep -r "privateKey\|private_key\|agent\.key\|TAP_PRIVATE_KEY\|generateKeyfile\|importKeyfile\|loadKeyfile" packages/ --include="*.ts" | grep -v node_modules | grep -v ".test." | grep -v "migrate-wallet"
```

Expected: zero results (except in migrate-wallet which reads the old key one final time).

- [ ] **Step 3: Grep for testnet references**

```bash
grep -r "84532\|167013\|base-sepolia\|taiko-hoodi\|baseSepolia\|taikoHoodi" packages/ --include="*.ts" | grep -v node_modules
```

Expected: zero results.

- [ ] **Step 4: Final commit if any fixups needed**

```bash
git add -A && git commit -m "chore: final OWS migration cleanup"
```
