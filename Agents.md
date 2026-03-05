# Agents.md

## Project Overview

**tap** (Trusted Agents Protocol) — a peer-to-peer protocol for AI agent communication on Ethereum. Agents register on-chain via ERC-8004 NFTs, discover each other through IPFS-hosted registration files, and communicate over XMTP encrypted messaging.

No central server. Agents run locally (CLI or embedded) and coordinate through on-chain registry + direct XMTP messaging.

## Tech Stack

| Tool | Version | Notes |
|------|---------|-------|
| **Bun** | workspace manager | Package manager AND script runner. Use `bun install`, `bun run test`, etc. |
| **TypeScript** | ^5.7 | Strict mode, ES2022 target, ESM only |
| **Biome** | ^1.9 | Linter AND formatter (NOT ESLint/Prettier) |
| **Vitest** | ^3.0 | Test framework |
| **viem** | ^2.23 | Ethereum client library |
| **@xmtp/node-sdk** | ^5.4 | Encrypted messaging transport |
| **Commander** | ^13 | CLI framework (packages/cli only) |

## Project Structure

```
trusted-agents/
├── package.json              # Root workspace config
├── tsconfig.base.json        # Shared TS settings (all packages extend this)
├── biome.json                # Monorepo-wide lint/format config
├── bun.lock
│
├── packages/core/            # Protocol library — no CLI, no side effects
│   └── src/
│       ├── common/           # Errors, crypto, validation, mutex, paths
│       ├── config/           # Schema, defaults, types
│       ├── identity/         # ERC-8004 registry, agent resolution, registration files
│       ├── protocol/         # JSON-RPC method constants, message types
│       ├── transport/        # TransportProvider interface + XMTP implementation
│       ├── connection/       # Invite generation/verification, handshake
│       ├── trust/            # Contact store (ITrustStore, FileTrustStore)
│       ├── permissions/      # Scope-based permission engine
│       ├── conversation/     # Message logging (FileConversationLogger)
│       └── index.ts          # Barrel exports
│
├── packages/cli/             # "tap" CLI tool
│   └── src/
│       ├── bin.ts            # Entry point (#!/usr/bin/env node)
│       ├── cli.ts            # Commander program definition
│       ├── types.ts          # CLI-specific types
│       ├── lib/              # Config loader, wallet, keyfile, output, errors, IPFS
│       └── commands/         # One file per command (init, register, connect, etc.)
│
└── packages/sdk/             # Programmatic SDK for agent integration
    ├── src/
    │   ├── orchestrator.ts   # TrustedAgentsOrchestrator class
    │   ├── approval.ts       # ApprovalHandler for connection consent
    │   ├── notification.ts   # NotificationAdapter interface
    │   ├── commands/         # execute* functions (invite, connect, contacts, conversations)
    │   └── index.ts
    └── skills/trusted-agents/ # SKILL.md definitions per operation
```

**Dependency graph**: `cli` → `core`, `sdk` → `core`. Core has zero internal package deps.

## Commands

```bash
bun install                  # Install all workspace packages
bun run build                # Build all packages (tsc → dist/)
bun run test                 # Run all tests (vitest run)
bun run test:watch           # Watch mode
bun run test:xmtp            # XMTP integration test (needs XMTP_INTEGRATION=true)
bun run typecheck            # Type-check all packages (sequential: core first)
bun run lint                 # Biome check
bun run lint:fix             # Biome auto-fix
bun run format               # Biome format
```

## Code Conventions

### TypeScript — ESM Only

- **All imports must use `.js` extensions** — even for `.ts` source files:
  ```typescript
  import { ConfigError } from "../common/errors.js";
  import type { TrustedAgentsConfig } from "./types.js";
  ```
- No path aliases — use relative paths
- `type` keyword required for type-only imports (`import type { ... }`)
- `verbatimModuleSyntax: true` — TypeScript preserves import/export forms exactly

### Formatting (Biome)

- **Tabs** for indentation (not spaces)
- **Double quotes** for strings
- **Semicolons always**
- **100-char line width**
- Imports auto-organized (sorted by biome)

### Naming

| What | Convention | Example |
|------|-----------|---------|
| Files & directories | kebab-case | `registration-file.ts`, `pending-invites/` |
| Types, interfaces, classes | PascalCase | `ResolvedAgent`, `FileTrustStore` |
| Functions & variables | camelCase, verb-first | `validateConfig()`, `isEthereumAddress()` |
| Constants | SCREAMING_SNAKE or camelCase | `CONNECTION_REQUEST`, `DEFAULT_CONFIG` |
| Env vars | `TAP_` prefix | `TAP_PRIVATE_KEY`, `TAP_CHAIN` |
| No `I` prefix | on interfaces | `ITrustStore` is the exception (legacy) |

### Exports

- **Named exports only** (no default exports)
- Barrel exports via `index.ts` in each module directory
- Packages export via `src/index.ts` → compiled `dist/index.js`

### Error Handling

Custom error hierarchy in `packages/core/src/common/errors.ts`:

```
TrustedAgentError (base)
├── AuthenticationError     (AUTH_ERROR)
├── IdentityError           (IDENTITY_ERROR)
├── ConnectionError         (CONNECTION_ERROR)
├── PermissionError         (PERMISSION_ERROR)
├── TransportError          (TRANSPORT_ERROR)
├── ConfigError             (CONFIG_ERROR)
└── ValidationError         (VALIDATION_ERROR)
```

CLI maps these to exit codes: 0=success, 1=general, 2=usage, 3=network, 4=identity, 5=permission.

## Testing

**Framework**: Vitest 3.x with Node environment.

**Structure**:
```
packages/*/test/
├── unit/           # Isolated tests with mocks (core package)
├── integration/    # End-to-end flows
├── fixtures/       # Test data (registration files, keys, messages)
└── helpers/        # Factory functions (createTestContact, createMockPublicClient)
```

**Patterns**:
- Test files: `*.test.ts`
- Mocking: `vi.fn()`, `vi.spyOn()`, `vi.restoreAllMocks()` in `afterEach`
- Temp directories: `mkdtemp()` + cleanup in `afterEach` for file-based tests
- Test keys: Well-known Hardhat/Anvil accounts (ALICE, BOB) from `test/fixtures/test-keys.ts`
- Timeout: 10 seconds default
- Each package has its own `vitest.config.ts`

**CLI tests** are flat in `packages/cli/test/`. **Core tests** are organized by feature under `test/unit/`.

## Architecture — Key Concepts

### Identity (ERC-8004)

Agents register on-chain via ERC-8004 NFT registry. The NFT `tokenId` becomes the `agentId`.

- **Registration file**: JSON on IPFS with name, description, XMTP endpoint, capabilities
- **AgentResolver**: Resolves `agentId` → `ResolvedAgent` by querying the registry contract + fetching IPFS metadata. Has LRU cache (1000 entries, 24h TTL).
- **Registry addresses** (CREATE2 — deterministic):
  - Base Mainnet: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
  - Base Sepolia: `0x8004A818BFB912233c491871b3d84c89A494BD9e`

### Transport (XMTP)

`TransportProvider` is the abstract interface. `XmtpTransport` is the only implementation.

- Sends/receives JSON-RPC protocol messages over XMTP DMs
- Agent's Ethereum address = XMTP endpoint (same key for both)
- XMTP database encrypted with deterministic key: `keccak256("xmtp-db-encryption:" + privateKey)`
- Request-response pattern with timeout + pending request tracking

### Connection Handshake

1. Agent A generates invite (signed with private key, includes nonce + expiry)
2. Agent B parses invite URL, verifies signature (recovers signer address)
3. Agent B sends `connection/request` via XMTP
4. Agent A responds `connection/accept` or `connection/reject`
5. Both store `Contact` in their trust store

### Trust Store

File-based (`contacts.json`) with `AsyncMutex` for concurrent access. Atomic writes via temp-file + rename.

### Protocol

JSON-RPC 2.0 based. Methods: `connection/request`, `connection/accept`, `connection/reject`, `message/send`.

### Permissions

Freeform string scopes per contact. Values are `boolean` or constraint objects (`{ maxCalls: 100 }`). Evaluated by `PermissionEngine`.

## Non-Obvious Things

1. **Bun is the package manager** — not npm/yarn/pnpm. All scripts use `bun run`.

2. **ESM `.js` extensions are mandatory** — TypeScript source files import with `.js` extension. This is required by `verbatimModuleSyntax` + ESM module resolution. Forgetting `.js` will cause runtime errors.

3. **Biome, not ESLint/Prettier** — run `bun run lint:fix` and `bun run format`. Biome handles both linting and formatting in one tool.

4. **Tab indentation** — Biome enforces tabs, not spaces.

5. **Single private key = everything** — the Ethereum private key is used for: on-chain identity (ERC-8004 owner), invite signing, XMTP client identity, and XMTP DB encryption seed. It's the single root of trust.

6. **Agent address duality** — Ethereum address serves as both the on-chain identity proof AND the XMTP messaging endpoint.

7. **CAIP-2 chain identifiers** — chains are referenced as `eip155:<chainId>` (e.g., `eip155:84532` for Base Sepolia), not by name.

8. **Workspace protocol** — packages reference each other with `workspace:*` in package.json. Don't use version numbers for internal deps.

9. **Build order matters for typecheck** — `bun run typecheck` builds core first, then checks cli and sdk in parallel (they depend on core's `.d.ts` output).

10. **No coverage config** — vitest configs are minimal. Run `vitest run --coverage` manually if needed.

11. **XMTP integration tests require env var** — set `XMTP_INTEGRATION=true` to run XMTP transport tests. They're skipped by default.

12. **File storage paths**:
    ```
    ~/.config/trustedagents/config.yaml    # Config file
    ~/.local/share/trustedagents/          # Data directory (or ~/.trustedagents/ fallback)
      ├── identity/agent.key               # Private key (0600 permissions)
      ├── contacts.json                    # Trust store
      ├── pending-invites.json             # Invite nonce state
      ├── conversations/<id>.json          # Message logs
      └── xmtp/<inbox-id>.db3             # XMTP client DB (encrypted)
    ```

13. **CLI output modes** — commands auto-detect TTY (plain text) vs piped (JSON envelope). Override with `--json` or `--plain`.

14. **x402 payment protocol** — the CLI `register` command uses x402 to pay for IPFS uploads with USDC from the agent's wallet. Alternative: Pinata JWT or self-hosted URI.

15. **`noUnusedLocals` and `noUnusedParameters` are on** — TypeScript will error on unused variables. Prefix with `_` if intentionally unused.
