# OWS Migration Design

Migrate Trusted Agents Protocol (TAP) from raw private key management to Open Wallet Standard (OWS) for all signing operations. Includes testnet removal as a natural cleanup.

**GitHub Issue**: #43

## Goals

1. Replace raw private key storage (`identity/agent.key`) with OWS encrypted vault
2. Agents use scoped, policy-gated API tokens — never raw keys
3. Preserve support for EOA, EIP-7702, and EIP-4337 execution modes
4. Smooth migration path for existing agents (import key, preserve identity)
5. Remove testnet chains (Base Sepolia, Taiko Hoodi) — L2 mainnet costs are negligible
6. Update documentation and skills to reflect new key management

## Non-Goals

- Custom spending-limit policies at onboarding (keep it simple: `allowed_chains` + `expires_at`)
- OWS-native smart account support (OWS manages the signing key; execution mode logic stays in TAP)
- Legacy/fallback key management path (OWS is the only path)

## Design

### 1. `SigningProvider` Interface

New file: `packages/core/src/signing/provider.ts`

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
  /** The EVM address derived from the underlying key. */
  getAddress(): Promise<`0x${string}`>;

  /** Sign an arbitrary message (EIP-191). Used by XMTP signer and invite signing. */
  signMessage(message: SignableMessage): Promise<Hex>;

  /** Sign a typed data structure (EIP-712). Used by EIP-4337 UserOp signing. */
  signTypedData(params: SignTypedDataParameters): Promise<Hex>;

  /** Sign a raw transaction. Used by EOA execution. */
  signTransaction(tx: TransactionSerializable): Promise<Hex>;

  /** Sign an EIP-7702 authorization. Used by 7702 execution mode. */
  signAuthorization(params: AuthorizationParameters): Promise<SignedAuthorization>;
}
```

Every signing operation in TAP maps to one of these five methods:

| TAP operation | Method |
|---|---|
| XMTP identity + protocol messages | `signMessage` |
| Invite generation | `signMessage` |
| EOA transfers | `signTransaction` |
| EIP-7702 delegation | `signAuthorization` |
| EIP-4337 UserOp signing | `signTypedData` |
| x402 IPFS payment | `signMessage` / `signTransaction` |
| Address derivation (everywhere) | `getAddress` |

### 2. `OwsSigningProvider` Implementation

New file: `packages/core/src/signing/ows-provider.ts`

Wraps `@open-wallet-standard/core` SDK functions. Captures `walletName`, `chain`, and `apiToken` at construction time.

```ts
import { signMessage, signTransaction } from "@open-wallet-standard/core";

export class OwsSigningProvider implements SigningProvider {
  constructor(
    private walletName: string,
    private chain: string,      // CAIP-2, e.g. "eip155:8453"
    private apiKey: string,     // "ows_key_..."
  ) {}

  async getAddress(): Promise<`0x${string}`> {
    // Derive from wallet accounts list for the given chain
  }

  async signMessage(message: SignableMessage): Promise<Hex> {
    // Delegate to OWS SDK signMessage
  }

  async signTransaction(tx: TransactionSerializable): Promise<Hex> {
    // Delegate to OWS SDK signTransaction
  }

  async signTypedData(params: SignTypedDataParameters): Promise<Hex> {
    // OWS signMessage with EIP-712 hash
  }

  async signAuthorization(params: AuthorizationParameters): Promise<SignedAuthorization> {
    // Sign authorization struct via OWS signMessage
  }
}
```

### 3. Custom Viem Account Adapter

To integrate with viem's `WalletClient` (used by execution paths), create a custom account:

```ts
import { toAccount } from "viem/accounts";

export async function createOwsViemAccount(
  provider: SigningProvider,
): Promise<CustomAccount> {
  const address = await provider.getAddress();
  return toAccount({
    address,
    signMessage: ({ message }) => provider.signMessage(message),
    signTransaction: (tx) => provider.signTransaction(tx),
    signTypedData: (params) => provider.signTypedData(params),
  });
}
```

This plugs into existing execution code — bundler clients, paymaster interactions, and `sendTransaction` calls remain unchanged.

### 4. Config Changes

#### `TrustedAgentsConfig` type (`packages/core/src/config/types.ts`)

Remove `privateKey: Hex`. Add:

```ts
ows: {
  wallet: string;   // OWS wallet name
  apiKey: string;    // scoped API token ("ows_key_...")
}
```

#### Config schema validator (`packages/core/src/config/schema.ts`)

The current validator requires `privateKey` as a 32-byte hex string. Update to:
- Remove `privateKey` validation
- Add `ows.wallet` (non-empty string) and `ows.apiKey` (must start with `ows_key_`) validation

#### Config loader (`packages/core/src/config/load.ts`)

This file has its own `loadKeyfile()` function (separate from the CLI's `keyfile.ts`) that reads `identity/agent.key`. Changes:
- Remove the internal `loadKeyfile()` function
- Replace key loading with reading `ows` block from config.yaml
- Update default chain from `eip155:84532` (Base Sepolia) to `eip155:8453` (Base mainnet)
- Update `getDefaultExecutionModeForChain()` — remove `"base-sepolia"` and `"eip155:84532"` entries

#### `config.yaml` new shape

```yaml
agent_id: 42
chain: eip155:8453
ows:
  wallet: "tap-agent-42"
  apiKey: "ows_key_a1b2c3..."
xmtp:
  dbEncryptionKey: "0xabc..."  # persisted during migration, derived for new agents
```

The `xmtp.env` field is removed (always `production` — see testnet removal below).

#### Environment variable changes

- Remove `TAP_PRIVATE_KEY` support (read site: `packages/cli/src/lib/config-loader.ts`)
- Add `TAP_OWS_WALLET` and `TAP_OWS_API_KEY` as optional overrides (same precedence pattern as today: flag > env > config file)

### 5. XMTP Signer Wiring

`createXmtpSigner` changes signature from `(privateKey: Hex)` to `(provider: SigningProvider)`:

```ts
export async function createXmtpSigner(provider: SigningProvider): Promise<Signer> {
  const address = await provider.getAddress();

  return {
    type: "EOA",
    getIdentifier: () => ({
      identifier: address,
      identifierKind: IDENTIFIER_KIND_ETHEREUM,
    }),
    signMessage: async (message: string): Promise<Uint8Array> => {
      const signature = await provider.signMessage(message);
      return hexToBytes(signature);
    },
  };
}
```

#### XMTP DB Encryption Key

- **New agents**: Derived from `provider.signMessage("xmtp-db-encryption-key")` then hashed. Deterministic because ECDSA with RFC 6979 (which OWS uses) always produces the same signature for the same input. This is a hard requirement — a non-deterministic signer would break XMTP DB continuity across restarts.
- **Migration**: Compute `keccak256("xmtp-db-encryption:" + privateKey)` from the old key, persist as `xmtp.dbEncryptionKey` in config.yaml, then delete the key. Existing XMTP databases remain readable.

### 6. Core Wiring Changes

#### Construction point

`SigningProvider` is constructed once per agent lifecycle at the host adapter layer:

- **CLI** (`packages/cli/src/lib/context.ts`): reads `config.ows`, creates `OwsSigningProvider`, attaches to context.
- **OpenClaw plugin** (`packages/openclaw-plugin/src/registry.ts`): reads `ows` from each identity's config, creates provider per identity.

#### `buildChainWalletClient` (`packages/core/src/common/viem.ts`)

Current signature: `buildChainWalletClient(privateKey, chainConfig) → WalletClient`. Refactored to accept the custom viem account from `createOwsViemAccount()` instead of a raw key:

```ts
buildChainWalletClient(account: CustomAccount, chainConfig: ChainConfig) → WalletClient
```

#### `BaseExecutionContext` type (`packages/core/src/runtime/execution/types.ts`)

The `owner` field is currently typed as `ReturnType<typeof privateKeyToAccount>` (viem `PrivateKeyAccount`). Changes to accept the custom viem account from `createOwsViemAccount()`. The `walletClient` field type also updates since it's built from the new account.

#### `resolveExecutionContext` (`packages/core/src/runtime/execution.ts`)

- Receives `SigningProvider` instead of pulling `config.privateKey`
- Calls `createOwsViemAccount(provider)` instead of `privateKeyToAccount(config.privateKey)`
- Passes the custom account to `buildChainWalletClient` and stores it as `owner`
- All execution modes (EOA, 7702, 4337) work through the same custom account
- Servo EIP-4337 path (`execution/servo.ts`) uses `context.owner.signMessage()` and `context.owner.signTypedData()` — these route through the custom account to OWS automatically

#### Invite signing (`packages/core/src/connection/invite.ts`)

- `generateInvite()` takes `SigningProvider` instead of `privateKey`
- Calls `provider.signMessage()` with `{ raw: toBytes(message) }` form (viem's `SignableMessage` supports this)

#### x402 payment (`packages/cli/src/lib/ipfs.ts`)

- Constructs a second `OwsSigningProvider` scoped to Base mainnet (`eip155:8453`) for x402 payment
- The OWS policy must include `eip155:8453` in `allowed_chains` — `tap init` handles this automatically when the agent's chain is different from Base
- Remove testnet entry from `TAIKO_CHAINS` set (`eip155:167013`)

#### Multi-chain API key scoping

A single OWS API key can cover multiple chains via an `allowed_chains` policy rule with multiple entries (e.g., `["eip155:8453", "eip155:167000"]`). One API key per agent identity is sufficient — no need for separate keys per chain. The `OwsSigningProvider` is constructed with the agent's primary chain, but the same `apiKey` works for x402 on Base since the policy allows both chains.

#### `TapMessagingService` (`packages/core/src/runtime/service.ts`)

- Constructor accepts `SigningProvider`
- `localAgentAddress` derivation changes from `privateKeyToAccount(config.privateKey).address` to `await provider.getAddress()`
- Passes provider to transport, transfer executor, and invite signing
- No direct key access anywhere in the service

#### `XmtpTransportConfig` (`packages/core/src/transport/xmtp-types.ts`)

- Remove `privateKey: \`0x${string}\`` field
- Add `signingProvider: SigningProvider` field
- `XmtpTransport.start()` uses the provider to build the XMTP signer

#### `remove` command (`packages/cli/src/commands/remove.ts`)

- Currently calls `privateKeyToAccount()` and `buildWalletClient()` directly to transfer remaining native balance during agent deregistration
- Changes to receive `SigningProvider` from the CLI context and use `createOwsViemAccount()` for the transfer

#### OpenClaw plugin direct key usages (`packages/openclaw-plugin/src/registry.ts`)

- Line 216: `privateKey: runtime.config.privateKey` (for `generateInvite`) → use `runtime.signingProvider`
- Line 298: `privateKeyToAccount(runtime.config.privateKey).address` (for `requestFunds`) → use `await runtime.signingProvider.getAddress()`

### 7. `tap init` Flow (New Agents)

```
1. Check if `ows` CLI is available on PATH
2. If not → prompt: "TAP requires Open Wallet. Install now? (Y/n)"
   → run: curl -fsSL https://docs.openwallet.sh/install.sh | bash
   → verify installation succeeded
3. Prompt: "Create a new wallet or use an existing one?"
   a) New → ows wallet create --name "tap-<randomSuffix>"
   b) Existing → ows wallet list → user selects
4. Policy setup:
   a) ows policy list → show compatible existing policies
   b) If any have allowed_chains covering the selected chain → offer reuse
   c) Otherwise → create new policy:
      - allowed_chains: [<selected chain>] (+ eip155:8453 if chain != Base for x402)
      - expires_at: 1 year from now
5. Create API key:
   ows key create --name "tap-<agentName>" --wallet <wallet> --policy <policyId>
6. Write config.yaml with ows.wallet and ows.apiKey
7. Derive and persist xmtp.dbEncryptionKey via signed-message derivation
8. Proceed to ERC-8004 registration (unchanged, uses SigningProvider)
```

### 8. `tap migrate-wallet` Flow (Existing Agents)

```
1. Verify OWS is installed (auto-install if not)
2. Read existing identity/agent.key
3. Compute and persist XMTP DB encryption key:
   keccak256("xmtp-db-encryption:" + privateKey) → config.yaml xmtp.dbEncryptionKey
4. Import key into OWS:
   echo <key> | ows wallet import --name "tap-agent-<agentId>" --private-key
5. Policy setup (same flow as tap init step 4)
6. Create API key (same as tap init step 5)
7. Update config.yaml: add ows block
8. Verification:
   - Sign test message via OWS
   - Compare derived address matches existing agent address
   - If mismatch → abort, restore original config, print error
9. Delete identity/agent.key
10. Print: "Migration complete. Key now managed by OWS."
```

Safety: step 8 verifies address match before deleting the keyfile. On failure, everything is left untouched.

### 9. OpenClaw Plugin Config

The plugin config itself does **not** change — it still specifies `dataDir` per identity. The `ows` config lives inside each identity's `config.yaml` (within the data dir) and is loaded transitively by `loadTrustedAgentConfigFromDataDir()`. This is the same pattern as today where `identity/agent.key` lives inside the data dir.

```json
{
  "identities": [
    { "dataDir": "/path/to/agent-data" }
  ]
}
```

Inside `/path/to/agent-data/config.yaml`:
```yaml
agent_id: 42
chain: eip155:8453
ows:
  wallet: "tap-agent-42"
  apiKey: "ows_key_a1b2c3..."
```

The plugin's `registry.ts` constructs an `OwsSigningProvider` from `runtime.config.ows` and passes it to `TapMessagingService` instead of passing `runtime.config.privateKey`.

### 10. Testnet Removal

Removing testnet chains as a natural cleanup — L2 mainnet gas costs are negligible.

#### Chains after cleanup

| Network | CAIP-2 | Status |
|---|---|---|
| Base | `eip155:8453` | Kept (default) |
| Base Sepolia | `eip155:84532` | Removed |
| Taiko | `eip155:167000` | Kept |
| Taiko Hoodi | `eip155:167013` | Removed |

#### Changes

- Default chain: `eip155:8453` (Base mainnet)
- `xmtp.env` config field removed — hardcode `production`
- `packages/core/src/config/load.ts` — update default chain from `eip155:84532` to `eip155:8453`; update `getDefaultExecutionModeForChain()` to remove `"base-sepolia"` / `"eip155:84532"` entries
- `packages/cli/src/lib/chains.ts` — remove `base-sepolia` and `taiko-hoodi` aliases from `ALL_CHAINS`
- `packages/cli/src/lib/wallet.ts` — remove testnet viem chain mappings
- `packages/core/src/common/viem.ts` — remove `baseSepolia` and `taikoHoodi` imports from `viem/chains`; remove `84532` and `167013` entries from `VIEM_CHAINS` map; remove `84532` from `RPC_FALLBACK_URLS`
- `packages/core/src/runtime/assets.ts` — remove `eip155:167013` USDC config entry
- `packages/cli/src/lib/ipfs.ts` — remove `eip155:167013` from `TAIKO_CHAINS` set
- `packages/core/src/transport/xmtp.ts` — remove `env` config branching
- Testnet contract addresses removed from registry config

### 11. Dependency & Package Changes

#### Added

- `@open-wallet-standard/core` in `packages/core/package.json` (Node.js SDK, NAPI bindings)

#### Removed

- `packages/cli/src/lib/keyfile.ts` — deleted entirely
- `loadKeyfile()` in `packages/core/src/config/load.ts` — removed (this is a separate function from the CLI's keyfile.ts)
- `privateKey` from `TrustedAgentsConfig` type and `config/schema.ts` validator
- `TAP_PRIVATE_KEY` env var support (in `packages/cli/src/lib/config-loader.ts`)
- `identity/agent.key` file convention
- Testnet chain entries, aliases, contract addresses, and RPC URLs

#### CI

- Add OWS installation step before tests
- Create test wallet + permissive policy for E2E tests
- E2E two-agent flow test creates two separate OWS wallets

### 12. Documentation & Skill Updates

#### CLAUDE.md

- Update "Non-Obvious Behavior" section 1 (single private key) to describe OWS wallet + API token
- Update "Non-Obvious Behavior" section 2 (XMTP DB encryption) to describe signed-message derivation + migration persistence
- Update "Config lives inside data-dir" section — new config.yaml shape, `identity/agent.key` no longer exists
- Update "Chain support differs between layers" — testnets removed
- Remove references to `TAP_PRIVATE_KEY` env var
- Add `ows` config fields to the data-dir tree diagram
- Update "Build/Test Commands" with OWS CI setup

#### Skills (`skills/trusted-agents/SKILL.md`)

Update using the skill-creator skill:

- Update `tap init` command docs with OWS onboarding flow
- Add `tap migrate-wallet` command documentation
- Remove testnet chain references
- Update config documentation to show `ows` block instead of `agent.key`
- Remove any references to raw private key management
- Update OpenClaw plugin mode section with `ows` config fields
- Update troubleshooting for OWS-related errors

#### Other docs

- Update `LIVE_SMOKE_RUNBOOK.md` — remove testnet steps, update for OWS
- Update any README files referencing key management

### 13. Testing Strategy

- **Unit tests**: Mock `SigningProvider` interface — return canned signatures. No OWS or raw key needed.
- **E2E tests**: Install OWS in CI, create throwaway wallets with permissive policies. Two-agent flow test uses two separate OWS wallets.
- **Migration test**: Create a legacy data dir with `agent.key`, run `tap migrate-wallet`, verify OWS wallet created, config updated, keyfile deleted, address matches.
- **XMTP integration test** (`XMTP_INTEGRATION=true`): Uses real OWS wallet for XMTP signing.
- **E2E two-agent flow test** (`packages/cli/test/e2e-two-agent-flow.test.ts`): Must be updated per CLAUDE.md's "Deterministic E2E Maintenance" rules — config shape change, `init` flow change, and key management change all qualify as meaningful behavioral changes.

## Exhaustive Files to Modify

### New files
- `packages/core/src/signing/provider.ts` — `SigningProvider` interface
- `packages/core/src/signing/ows-provider.ts` — `OwsSigningProvider` implementation
- `packages/core/src/signing/viem-account.ts` — `createOwsViemAccount()` adapter
- `packages/cli/src/commands/migrate-wallet.ts` — migration command

### Modified files (core)
- `packages/core/src/config/types.ts` — remove `privateKey`, add `ows`
- `packages/core/src/config/schema.ts` — remove `privateKey` validation, add `ows` validation
- `packages/core/src/config/load.ts` — remove `loadKeyfile()`, load `ows` from config, update default chain, update `StoredYamlConfig` interface to include `ows` field, remove `LoadTrustedAgentConfigOptions.privateKey` override, remove `getDefaultExecutionModeForChain()` testnet entries
- `packages/core/src/config/defaults.ts` — update `DEFAULT_CONFIG` `Omit` type (currently omits `"privateKey"`, change to omit `"ows"`)
- `packages/core/src/common/viem.ts` — refactor `buildChainWalletClient` signature, remove testnet chains/RPCs
- `packages/core/src/transport/xmtp.ts` — use `SigningProvider`, remove `env` branching
- `packages/core/src/transport/xmtp-signer.ts` — accept `SigningProvider` instead of raw key
- `packages/core/src/transport/xmtp-types.ts` — replace `privateKey` with `signingProvider` in config type
- `packages/core/src/connection/invite.ts` — accept `SigningProvider`
- `packages/core/src/runtime/service.ts` — accept `SigningProvider`, update `localAgentAddress`
- `packages/core/src/runtime/default-context.ts` — replace `config.privateKey` with `SigningProvider` when constructing `XmtpTransport`; remove `config.xmtpEnv` usage
- `packages/core/src/runtime/execution.ts` — use `SigningProvider` + custom viem account
- `packages/core/src/runtime/execution/types.ts` — update `BaseExecutionContext.owner` and `.walletClient` types
- `packages/core/src/runtime/execution/servo.ts` — unchanged (uses `context.owner` which is now the custom account)
- `packages/core/src/runtime/assets.ts` — remove testnet USDC entries

### Modified files (CLI)
- `packages/cli/src/cli.ts` — remove `--private-key` flag from `init` command, add OWS-related flags if needed
- `packages/cli/src/lib/context.ts` — construct `OwsSigningProvider`
- `packages/cli/src/lib/config-loader.ts` — remove `TAP_PRIVATE_KEY`, add `TAP_OWS_WALLET`/`TAP_OWS_API_KEY`
- `packages/cli/src/lib/chains.ts` — remove testnet aliases
- `packages/cli/src/lib/wallet.ts` — remove testnet viem mappings
- `packages/cli/src/lib/ipfs.ts` — use `SigningProvider` for x402 (change `uploadToIpfsX402` signature: replace `privateKey` param with `SigningProvider`, create viem account via `createOwsViemAccount` then pass to `toClientEvmSigner`), remove testnet from `TAIKO_CHAINS`
- `packages/cli/src/commands/init.ts` — OWS onboarding flow (replace `generateKeyfile`/`importKeyfile`/`loadKeyfile` imports, remove `isTestnet`/`xmtpEnv` logic, remove keyfile.ts dependency entirely)
- `packages/cli/src/commands/register.ts` — use `SigningProvider` (6+ `privateKey` usage sites including `privateKeyToAccount` calls and `resolveAgentURI` internal function signature)
- `packages/cli/src/commands/remove.ts` — use `SigningProvider` for balance transfer
- `packages/cli/src/commands/balance.ts` — replace `privateKeyToAccount(config.privateKey).address` with `provider.getAddress()`
- `packages/cli/src/commands/identity-show.ts` — replace `privateKeyToAccount(config.privateKey)` with `provider.getAddress()`
- `packages/cli/src/commands/message-request-funds.ts` — replace `privateKeyToAccount(config.privateKey).address` with `provider.getAddress()`
- `packages/cli/src/commands/invite-create.ts` — pass `SigningProvider` to `generateInvite()` instead of `config.privateKey`

### Modified files (OpenClaw plugin)
- `packages/openclaw-plugin/src/registry.ts` — use `SigningProvider`, remove direct `config.privateKey` usage (the `ows` config is read transitively from the identity's `config.yaml` via `loadTrustedAgentConfigFromDataDir()`)

### Deleted files
- `packages/cli/src/lib/keyfile.ts`

### Modified tests
- `packages/cli/test/e2e-two-agent-flow.test.ts` — update for OWS wallets and new config shape
- All unit tests mocking `config.privateKey` — mock `SigningProvider` instead

### Documentation
- `CLAUDE.md` — update key management, config, chain, and env var sections
- `skills/trusted-agents/SKILL.md` — update via skill-creator
- `LIVE_SMOKE_RUNBOOK.md` — remove testnet steps, add OWS setup

## Risk & Mitigation

| Risk | Mitigation |
|---|---|
| OWS install fails in CI or user machine | Auto-install with clear error messages; CI caches OWS binary |
| Migration corrupts agent identity | Address verification before keyfile deletion; abort on mismatch |
| XMTP DB becomes unreadable after migration | Persist encryption key in config before migration |
| OWS SDK latency affects XMTP throughput | OWS NAPI calls are in-process microseconds, not network calls |
| Policy too restrictive blocks legitimate operations | `tap init` auto-includes x402 chain; clear error when policy denies |
| Existing agents on testnets can't migrate | Migration must happen before testnet removal; or accept that testnet agents re-register on mainnet |
