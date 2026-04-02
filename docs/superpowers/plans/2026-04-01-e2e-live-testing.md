# E2E Live Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automated end-to-end tests that exercise the full TAP user journey against real infrastructure (XMTP, OWS, on-chain registry, USDC transfers) on Base and Taiko mainnet, gating every npm release.

**Architecture:** Two E2E test files share scenario definitions and assertion helpers. The real E2E (`e2e-live.test.ts`) hits mainnet; the mocked E2E (`e2e-mock.test.ts`) uses loopback transport for fast CI. Both live in `packages/cli/test/e2e/`. The release workflow runs the real E2E as a matrix job (Base + Taiko) before publishing.

**Tech Stack:** Vitest, `runCli()` helper, viem for on-chain balance reads, GitHub Actions matrix strategy

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/test/e2e/scenarios.ts` | Shared scenario names and phase metadata |
| `packages/cli/test/e2e/helpers.ts` | Shared utilities: poll sync, balance reads, assertions |
| `packages/cli/test/e2e/e2e-live.test.ts` | Real E2E test (mainnet, real XMTP, real OWS) |
| `packages/cli/test/e2e/e2e-mock.test.ts` | Mocked E2E test (loopback transport, no network) |
| `.github/workflows/release.yml` | Modified: E2E gate + workflow_dispatch |
| `CLAUDE.md` | Modified: update E2E maintenance section |

Files to delete:
- `packages/cli/test/e2e-two-agent-flow.test.ts`
- `LIVE_SMOKE_RUNBOOK.md`

---

### Task 1: Create shared scenario definitions

**Files:**
- Create: `packages/cli/test/e2e/scenarios.ts`

- [ ] **Step 1: Create the scenarios file**

```typescript
// packages/cli/test/e2e/scenarios.ts

/**
 * Canonical scenario list shared between e2e-live and e2e-mock tests.
 * If you add a scenario to one test file, add it here and mirror it in the other.
 */
export const PHASES = {
	PREFLIGHT: 0,
	ONBOARDING: 1,
	CONNECTION: 2,
	PERMISSIONS: 3,
	MESSAGING: 4,
	TRANSFERS: 5,
} as const;

export const SCENARIOS = {
	// Phase 0: Preflight
	VALIDATE_ENV: { name: "Validate OWS wallet env vars", phase: PHASES.PREFLIGHT },

	// Phase 1: Onboarding & Identity
	INIT_AGENT_A: { name: "Init Agent A from OWS wallet", phase: PHASES.ONBOARDING },
	INIT_AGENT_B: { name: "Init Agent B from OWS wallet", phase: PHASES.ONBOARDING },
	BALANCE_CHECK_A: { name: "Check Agent A USDC balance", phase: PHASES.ONBOARDING },
	BALANCE_CHECK_B: { name: "Check Agent B USDC balance", phase: PHASES.ONBOARDING },
	REGISTER_AGENT_A: { name: "Register Agent A (IPFS + on-chain)", phase: PHASES.ONBOARDING },
	REGISTER_AGENT_B: { name: "Register Agent B (IPFS + on-chain)", phase: PHASES.ONBOARDING },
	RESOLVE_AGENT_A: { name: "Resolve Agent A identity", phase: PHASES.ONBOARDING },
	RESOLVE_AGENT_B: { name: "Resolve Agent B identity", phase: PHASES.ONBOARDING },

	// Phase 2: Connection & Trust
	CREATE_INVITE: { name: "Create invite (Agent A)", phase: PHASES.CONNECTION },
	ACCEPT_INVITE: { name: "Accept invite and connect (Agent B)", phase: PHASES.CONNECTION },
	SYNC_CONNECTION_A: { name: "Sync connection request (Agent A)", phase: PHASES.CONNECTION },
	SYNC_CONNECTION_B: { name: "Sync connection result (Agent B)", phase: PHASES.CONNECTION },
	VERIFY_CONTACTS_A: { name: "Verify Agent A contacts", phase: PHASES.CONNECTION },
	VERIFY_CONTACTS_B: { name: "Verify Agent B contacts", phase: PHASES.CONNECTION },

	// Phase 3: Permissions & Grants
	VERIFY_NO_GRANTS: { name: "Verify no grants before granting", phase: PHASES.PERMISSIONS },
	GRANT_TRANSFER: { name: "Grant USDC transfer permission", phase: PHASES.PERMISSIONS },
	SYNC_GRANT: { name: "Sync grant to grantee", phase: PHASES.PERMISSIONS },
	VERIFY_GRANT: { name: "Verify grant visible to grantee", phase: PHASES.PERMISSIONS },

	// Phase 4: Messaging
	SEND_MESSAGE_A_TO_B: { name: "Send message A to B", phase: PHASES.MESSAGING },
	SYNC_MESSAGE_B: { name: "Sync message to B", phase: PHASES.MESSAGING },
	SEND_MESSAGE_B_TO_A: { name: "Send message B to A", phase: PHASES.MESSAGING },
	SYNC_MESSAGE_A: { name: "Sync message to A", phase: PHASES.MESSAGING },
	VERIFY_CONVERSATIONS: { name: "Verify conversation logs", phase: PHASES.MESSAGING },

	// Phase 5: Transfers
	RECORD_BALANCE_BEFORE: { name: "Record Agent B balance before transfer", phase: PHASES.TRANSFERS },
	REQUEST_FUNDS_APPROVED: { name: "Request funds (approved by grant)", phase: PHASES.TRANSFERS },
	SYNC_TRANSFER_A: { name: "Sync transfer approval (Agent A)", phase: PHASES.TRANSFERS },
	SYNC_TRANSFER_RESULT_B: { name: "Sync transfer result (Agent B)", phase: PHASES.TRANSFERS },
	VERIFY_BALANCE_INCREASED: { name: "Verify Agent B balance increased", phase: PHASES.TRANSFERS },
	REVOKE_GRANT: { name: "Revoke transfer grant", phase: PHASES.TRANSFERS },
	SYNC_REVOCATION: { name: "Sync revocation to Agent B", phase: PHASES.TRANSFERS },
	REQUEST_FUNDS_REJECTED: { name: "Request funds (rejected, no grant)", phase: PHASES.TRANSFERS },
	SYNC_REJECTION_A: { name: "Sync rejection (Agent A auto-rejects)", phase: PHASES.TRANSFERS },
	SYNC_REJECTION_RESULT_B: { name: "Sync rejection result (Agent B)", phase: PHASES.TRANSFERS },
	VERIFY_BALANCE_UNCHANGED: { name: "Verify Agent B balance unchanged", phase: PHASES.TRANSFERS },
} as const;
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd /Users/gustavo/apps/trusted-agents-worktrees/end-to-end-testing && bunx tsc --noEmit packages/cli/test/e2e/scenarios.ts --esModuleInterop --module nodenext --moduleResolution nodenext --target es2022`

Expected: No errors (or use `bun run typecheck` after all files are in place).

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/e2e/scenarios.ts
git commit -m "feat(e2e): add shared scenario definitions"
```

---

### Task 2: Create shared test helpers

**Files:**
- Create: `packages/cli/test/e2e/helpers.ts`
- Reference: `packages/cli/test/helpers/run-cli.ts` (existing, unchanged)
- Reference: `packages/cli/src/lib/chains.ts` (for chain config)
- Reference: `packages/cli/src/lib/assets.ts` (for USDC addresses)

- [ ] **Step 1: Research chain configs and USDC contract addresses**

Read `packages/cli/src/lib/chains.ts` and `packages/cli/src/lib/assets.ts` to find the USDC contract addresses and RPC URLs for Base and Taiko. These values will be used in the balance-checking helper.

- [ ] **Step 2: Create the helpers file**

The helpers file provides:
- `waitForSync()` — polls `tap message sync` until expected output appears
- `getUsdcBalance()` — reads on-chain USDC balance via RPC using viem
- `assertContactActive()` — reads contacts.json and asserts active status
- `parseJsonOutput()` — extracts JSON envelope from CLI stdout
- `writeGrantFile()` — writes a grant JSON file to disk for `permissions grant`

```typescript
// packages/cli/test/e2e/helpers.ts

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { base, taiko } from "viem/chains";
import { runCli } from "../helpers/run-cli.js";
import type { CliRunResult } from "../helpers/run-cli.js";

// --- Chain and USDC config ---

interface ChainE2EConfig {
	caip2: string;
	alias: string;
	rpcUrl: string;
	viemChain: typeof base;
	usdcAddress: `0x${string}`;
	usdcDecimals: number;
}

export const CHAIN_CONFIGS: Record<string, ChainE2EConfig> = {
	base: {
		caip2: "eip155:8453",
		alias: "base",
		rpcUrl: "https://mainnet.base.org",
		viemChain: base,
		usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		usdcDecimals: 6,
	},
	taiko: {
		caip2: "eip155:167000",
		alias: "taiko",
		rpcUrl: "https://rpc.mainnet.taiko.xyz",
		viemChain: taiko,
		usdcAddress: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
		usdcDecimals: 6,
	},
};

const ERC20_BALANCE_ABI = parseAbi([
	"function balanceOf(address account) view returns (uint256)",
]);

// --- Balance helpers ---

export async function getUsdcBalance(
	address: `0x${string}`,
	chainKey: string,
): Promise<bigint> {
	const config = CHAIN_CONFIGS[chainKey];
	if (!config) throw new Error(`Unknown chain key: ${chainKey}`);

	const client = createPublicClient({
		chain: config.viemChain,
		transport: http(config.rpcUrl),
	});

	return await client.readContract({
		address: config.usdcAddress,
		abi: ERC20_BALANCE_ABI,
		functionName: "balanceOf",
		args: [address],
	});
}

export function formatUsdc(balance: bigint, chainKey: string): string {
	const config = CHAIN_CONFIGS[chainKey];
	if (!config) throw new Error(`Unknown chain key: ${chainKey}`);
	return formatUnits(balance, config.usdcDecimals);
}

// --- CLI output parsing ---

export function parseJsonOutput(stdout: string): { ok: boolean; data: unknown } {
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") || !trimmed.includes('"ok"')) continue;
		return JSON.parse(trimmed) as { ok: boolean; data: unknown };
	}
	throw new Error(`No JSON envelope found in output:\n${stdout}`);
}

// --- Sync polling ---

export async function waitForSync(opts: {
	dataDir: string;
	description: string;
	timeoutMs?: number;
	intervalMs?: number;
	expectPattern?: string | RegExp;
}): Promise<CliRunResult> {
	const timeout = opts.timeoutMs ?? 30_000;
	const interval = opts.intervalMs ?? 2_000;
	const deadline = Date.now() + timeout;
	let lastResult: CliRunResult | undefined;

	while (Date.now() < deadline) {
		const result = await runCli(["--json", "--data-dir", opts.dataDir, "message", "sync"]);
		lastResult = result;

		if (result.exitCode === 0) {
			if (!opts.expectPattern) return result;

			const combined = result.stdout + result.stderr;
			const matches =
				typeof opts.expectPattern === "string"
					? combined.includes(opts.expectPattern)
					: opts.expectPattern.test(combined);
			if (matches) return result;
		}

		await new Promise((r) => setTimeout(r, interval));
	}

	throw new Error(
		`waitForSync timed out (${timeout}ms): ${opts.description}\n` +
			`Last stdout: ${lastResult?.stdout ?? "(none)"}\n` +
			`Last stderr: ${lastResult?.stderr ?? "(none)"}`,
	);
}

// --- Contact assertions ---

export async function assertContactActive(
	dataDir: string,
	peerName: string,
): Promise<void> {
	const result = await runCli(["--json", "--data-dir", dataDir, "contacts", "list"]);
	if (result.exitCode !== 0) {
		throw new Error(`contacts list failed: ${result.stderr}`);
	}
	const { data } = parseJsonOutput(result.stdout) as {
		data: { contacts: Array<{ name: string; status: string }> };
	};
	const contact = data.contacts.find((c) => c.name === peerName);
	if (!contact) {
		throw new Error(
			`Contact "${peerName}" not found. Have: ${data.contacts.map((c) => c.name).join(", ")}`,
		);
	}
	if (contact.status !== "active") {
		throw new Error(`Contact "${peerName}" is "${contact.status}", expected "active"`);
	}
}

// --- Grant file helpers ---

export async function writeGrantFile(
	dir: string,
	filename: string,
	grants: Array<{
		grantId: string;
		scope: string;
		constraints?: Record<string, unknown>;
	}>,
): Promise<string> {
	const path = join(dir, filename);
	await writeFile(
		path,
		JSON.stringify({
			version: "tap-grants/v1",
			grants,
		}),
		"utf-8",
	);
	return path;
}

// --- Config helpers ---

export async function readAgentAddress(dataDir: string): Promise<`0x${string}`> {
	const result = await runCli(["--json", "--data-dir", dataDir, "identity", "show"]);
	if (result.exitCode !== 0) {
		throw new Error(`identity show failed: ${result.stderr}`);
	}
	const { data } = parseJsonOutput(result.stdout) as {
		data: { address: string };
	};
	return data.address as `0x${string}`;
}

// --- Permissions helpers ---

export async function waitForPermissions(
	dataDir: string,
	peer: string,
	predicate: (data: PermissionSnapshot) => boolean,
	timeoutMs = 30_000,
	intervalMs = 2_000,
): Promise<PermissionSnapshot> {
	const deadline = Date.now() + timeoutMs;
	let lastSnapshot: PermissionSnapshot | undefined;

	while (Date.now() < deadline) {
		// Sync first to pick up any pending permission updates
		await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);

		const result = await runCli(["--json", "--data-dir", dataDir, "permissions", "show", peer]);
		if (result.exitCode === 0) {
			const { data } = parseJsonOutput(result.stdout) as { data: PermissionSnapshot };
			lastSnapshot = data;
			if (predicate(data)) return data;
		}

		await new Promise((r) => setTimeout(r, intervalMs));
	}

	throw new Error(
		`Timed out waiting for permissions for ${peer}: ${JSON.stringify(lastSnapshot ?? null)}`,
	);
}

export interface PermissionSnapshot {
	granted_by_me: {
		grants: Array<{ grantId: string; status: string }>;
	};
	granted_by_peer: {
		grants: Array<{ grantId: string; status: string }>;
	};
}

// --- Balance wait helper ---

export async function waitForBalanceChange(opts: {
	address: `0x${string}`;
	chainKey: string;
	previousBalance: bigint;
	description: string;
	timeoutMs?: number;
	intervalMs?: number;
}): Promise<bigint> {
	const timeout = opts.timeoutMs ?? 30_000;
	const interval = opts.intervalMs ?? 3_000;
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		const current = await getUsdcBalance(opts.address, opts.chainKey);
		if (current !== opts.previousBalance) return current;
		await new Promise((r) => setTimeout(r, interval));
	}

	throw new Error(
		`Timed out waiting for balance change (${timeout}ms): ${opts.description}\n` +
			`Address: ${opts.address}, chain: ${opts.chainKey}, balance: ${formatUsdc(opts.previousBalance, opts.chainKey)} USDC`,
	);
}

// --- Env helpers ---

export function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Required environment variable ${name} is not set`);
	}
	return value;
}
```

- [ ] **Step 3: Verify the file compiles**

Run: `bun run typecheck`

Note: This may fail until the live and mock test files are also in place. Check for import errors in helpers.ts specifically. If USDC addresses or chain configs are wrong, check `packages/cli/src/lib/assets.ts` and `packages/cli/src/lib/chains.ts` for the actual values and update.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/e2e/helpers.ts
git commit -m "feat(e2e): add shared test helpers for live and mock E2E"
```

---

### Task 3: Create the real E2E test

**Files:**
- Create: `packages/cli/test/e2e/e2e-live.test.ts`
- Reference: `packages/cli/test/e2e/scenarios.ts` (Task 1)
- Reference: `packages/cli/test/e2e/helpers.ts` (Task 2)
- Reference: `packages/cli/test/helpers/run-cli.ts` (existing)

This is the core deliverable. The test reads OWS wallet credentials from env vars, creates fresh agent data dirs, and runs through all 5 phases against real infrastructure.

- [ ] **Step 1: Create the live E2E test file**

The test uses `describe.sequential` to enforce phase ordering. Each phase is a `describe` block. Tests within a phase are sequential and depend on previous tests.

The test reads `E2E_CHAIN` (default: `base`) to determine which chain to run against. The GitHub Actions matrix sets this per job.

```typescript
// packages/cli/test/e2e/e2e-live.test.ts

/**
 * Real E2E test — exercises the full TAP user journey against mainnet.
 *
 * Requires env vars:
 *   E2E_AGENT_A_OWS_WALLET  — Agent A wallet name
 *   E2E_AGENT_A_OWS_API_KEY — Agent A scoped API key
 *   E2E_AGENT_B_OWS_WALLET  — Agent B wallet name
 *   E2E_AGENT_B_OWS_API_KEY — Agent B scoped API key
 *   E2E_CHAIN               — Chain key: "base" or "taiko" (default: "base")
 *
 * Run manually:
 *   E2E_CHAIN=base E2E_AGENT_A_OWS_WALLET=... bun vitest run packages/cli/test/e2e/e2e-live.test.ts
 *
 * This test is skipped unless E2E_AGENT_A_OWS_WALLET is set.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnits } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/run-cli.js";
import { SCENARIOS } from "./scenarios.js";
import {
	CHAIN_CONFIGS,
	assertContactActive,
	formatUsdc,
	getUsdcBalance,
	parseJsonOutput,
	readAgentAddress,
	requireEnv,
	waitForBalanceChange,
	waitForPermissions,
	waitForSync,
	writeGrantFile,
} from "./helpers.js";

const SKIP = !process.env.E2E_AGENT_A_OWS_WALLET;
const CHAIN_KEY = process.env.E2E_CHAIN ?? "base";
const CHAIN = CHAIN_CONFIGS[CHAIN_KEY];
if (!CHAIN && !SKIP) {
	throw new Error(`Unknown E2E_CHAIN: ${CHAIN_KEY}. Use "base" or "taiko".`);
}

const MIN_USDC_BALANCE = parseUnits("0.50", 6); // 0.50 USDC
const TRANSFER_AMOUNT = "0.001"; // USDC
const TRANSFER_AMOUNT_UNITS = parseUnits(TRANSFER_AMOUNT, 6);
const GRANT_MAX_AMOUNT = "0.01"; // USDC

describe.skipIf(SKIP)(`E2E live: ${CHAIN_KEY}`, () => {
	let agentADir: string;
	let agentBDir: string;
	let tempRoot: string;
	let agentAWallet: string;
	let agentAApiKey: string;
	let agentBWallet: string;
	let agentBApiKey: string;
	let agentBAddress: `0x${string}`;

	// Shared state across phases
	let inviteUrl: string;
	let balanceBeforeTransfer: bigint;

	beforeAll(async () => {
		agentAWallet = requireEnv("E2E_AGENT_A_OWS_WALLET");
		agentAApiKey = requireEnv("E2E_AGENT_A_OWS_API_KEY");
		agentBWallet = requireEnv("E2E_AGENT_B_OWS_WALLET");
		agentBApiKey = requireEnv("E2E_AGENT_B_OWS_API_KEY");

		tempRoot = await mkdtemp(join(tmpdir(), `tap-e2e-live-${CHAIN_KEY}-`));
		agentADir = join(tempRoot, "agent-a");
		agentBDir = join(tempRoot, "agent-b");
		await mkdir(agentADir, { recursive: true });
		await mkdir(agentBDir, { recursive: true });
	});

	afterAll(async () => {
		if (tempRoot) {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	// ═══════════════════════════════════════════════════════
	// Phase 1: Onboarding & Identity
	// ═══════════════════════════════════════════════════════

	describe("Phase 1: Onboarding & Identity", () => {
		it(SCENARIOS.INIT_AGENT_A.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentADir,
				"init",
				"--chain", CHAIN!.alias,
				"--wallet", agentAWallet,
				"--passphrase", agentAApiKey,
				"--non-interactive",
			]);
			expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
		}, 30_000);

		it(SCENARIOS.INIT_AGENT_B.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentBDir,
				"init",
				"--chain", CHAIN!.alias,
				"--wallet", agentBWallet,
				"--passphrase", agentBApiKey,
				"--non-interactive",
			]);
			expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
		}, 30_000);

		it(SCENARIOS.BALANCE_CHECK_A.name, async () => {
			const address = await readAgentAddress(agentADir);
			const balance = await getUsdcBalance(address, CHAIN_KEY);
			if (balance < MIN_USDC_BALANCE) {
				throw new Error(
					`E2E ABORT: Agent A on ${CHAIN!.caip2} has ${formatUsdc(balance, CHAIN_KEY)} USDC.\n` +
					`Minimum required: 0.50 USDC.\n` +
					`Fund address ${address} on ${CHAIN!.alias} with USDC to continue.`,
				);
			}
		}, 15_000);

		it(SCENARIOS.BALANCE_CHECK_B.name, async () => {
			const address = await readAgentAddress(agentBDir);
			agentBAddress = address;
			const balance = await getUsdcBalance(address, CHAIN_KEY);
			if (balance < MIN_USDC_BALANCE) {
				throw new Error(
					`E2E ABORT: Agent B on ${CHAIN!.caip2} has ${formatUsdc(balance, CHAIN_KEY)} USDC.\n` +
					`Minimum required: 0.50 USDC.\n` +
					`Fund address ${address} on ${CHAIN!.alias} with USDC to continue.`,
				);
			}
		}, 15_000);

		it(SCENARIOS.REGISTER_AGENT_A.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentADir,
				"register", "create",
				"--name", `E2E-Agent-A-${CHAIN_KEY}`,
				"--description", `E2E test agent A on ${CHAIN_KEY}`,
				"--capabilities", "general-chat,payments",
			]);
			expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
		}, 120_000);

		it(SCENARIOS.REGISTER_AGENT_B.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentBDir,
				"register", "create",
				"--name", `E2E-Agent-B-${CHAIN_KEY}`,
				"--description", `E2E test agent B on ${CHAIN_KEY}`,
				"--capabilities", "general-chat,payments",
			]);
			expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
		}, 120_000);

		it(SCENARIOS.RESOLVE_AGENT_A.name, async () => {
			const result = await runCli([
				"--json",
				"--data-dir", agentADir,
				"identity", "resolve-self",
			]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as {
				data: { name: string; agentAddress: string };
			};
			expect(data.name).toBe(`E2E-Agent-A-${CHAIN_KEY}`);
			expect(data.agentAddress).toBeTruthy();
		}, 30_000);

		it(SCENARIOS.RESOLVE_AGENT_B.name, async () => {
			const result = await runCli([
				"--json",
				"--data-dir", agentBDir,
				"identity", "resolve-self",
			]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as {
				data: { name: string; agentAddress: string };
			};
			expect(data.name).toBe(`E2E-Agent-B-${CHAIN_KEY}`);
			expect(data.agentAddress).toBeTruthy();
		}, 30_000);
	});

	// ═══════════════════════════════════════════════════════
	// Phase 2: Connection & Trust
	// ═══════════════════════════════════════════════════════

	describe("Phase 2: Connection & Trust", () => {
		it(SCENARIOS.CREATE_INVITE.name, async () => {
			const result = await runCli([
				"--json",
				"--data-dir", agentADir,
				"invite", "create",
			]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as { data: { url: string } };
			expect(data.url).toBeTruthy();
			inviteUrl = data.url;
		}, 30_000);

		it(SCENARIOS.ACCEPT_INVITE.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentBDir,
				"connect", inviteUrl,
				"--yes",
			]);
			expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
		}, 60_000);

		it(SCENARIOS.SYNC_CONNECTION_A.name, async () => {
			await waitForSync({
				dataDir: agentADir,
				description: "Agent A receives connection/request from Agent B",
			});
		}, 60_000);

		it(SCENARIOS.SYNC_CONNECTION_B.name, async () => {
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receives connection/result from Agent A",
			});
		}, 60_000);

		it(SCENARIOS.VERIFY_CONTACTS_A.name, async () => {
			await assertContactActive(agentADir, `E2E-Agent-B-${CHAIN_KEY}`);
		});

		it(SCENARIOS.VERIFY_CONTACTS_B.name, async () => {
			await assertContactActive(agentBDir, `E2E-Agent-A-${CHAIN_KEY}`);
		});
	});

	// ═══════════════════════════════════════════════════════
	// Phase 3: Permissions & Grants
	// ═══════════════════════════════════════════════════════

	describe("Phase 3: Permissions & Grants", () => {
		it(SCENARIOS.VERIFY_NO_GRANTS.name, async () => {
			const result = await runCli([
				"--json",
				"--data-dir", agentBDir,
				"permissions", "show",
				`E2E-Agent-A-${CHAIN_KEY}`,
			]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as { data: PermissionSnapshot };
			expect(data.granted_by_peer.grants).toEqual([]);
		});

		it(SCENARIOS.GRANT_TRANSFER.name, async () => {
			const grantFile = await writeGrantFile(agentADir, "e2e-grants.json", [
				{
					grantId: "e2e-usdc-transfer",
					scope: "transfer/request",
					constraints: {
						asset: "usdc",
						chain: CHAIN!.caip2,
						maxAmount: GRANT_MAX_AMOUNT,
					},
				},
			]);
			const result = await runCli([
				"--plain",
				"--data-dir", agentADir,
				"permissions", "grant",
				`E2E-Agent-B-${CHAIN_KEY}`,
				"--file", grantFile,
				"--note", "e2e test grant",
			]);
			expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
		}, 60_000);

		it(SCENARIOS.SYNC_GRANT.name, async () => {
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receives permissions/update",
			});
		}, 60_000);

		it(SCENARIOS.VERIFY_GRANT.name, async () => {
			const perms = await waitForPermissions(
				agentBDir,
				`E2E-Agent-A-${CHAIN_KEY}`,
				(data) =>
					data.granted_by_peer.grants.some(
						(g) => g.grantId === "e2e-usdc-transfer" && g.status === "active",
					),
			);
			expect(
				perms.granted_by_peer.grants.find((g) => g.grantId === "e2e-usdc-transfer")?.status,
			).toBe("active");
		}, 60_000);
	});

	// ═══════════════════════════════════════════════════════
	// Phase 4: Messaging
	// ═══════════════════════════════════════════════════════

	describe("Phase 4: Messaging", () => {
		it(SCENARIOS.SEND_MESSAGE_A_TO_B.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentADir,
				"message", "send",
				`E2E-Agent-B-${CHAIN_KEY}`,
				"ping from agent A",
				"--scope", "general-chat",
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Sent:");
		}, 30_000);

		it(SCENARIOS.SYNC_MESSAGE_B.name, async () => {
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receives message from A",
			});
		}, 60_000);

		it(SCENARIOS.SEND_MESSAGE_B_TO_A.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentBDir,
				"message", "send",
				`E2E-Agent-A-${CHAIN_KEY}`,
				"pong from agent B",
				"--scope", "general-chat",
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Sent:");
		}, 30_000);

		it(SCENARIOS.SYNC_MESSAGE_A.name, async () => {
			await waitForSync({
				dataDir: agentADir,
				description: "Agent A receives message from B",
			});
		}, 60_000);

		it(SCENARIOS.VERIFY_CONVERSATIONS.name, async () => {
			for (const [dir, peer] of [
				[agentADir, `E2E-Agent-B-${CHAIN_KEY}`],
				[agentBDir, `E2E-Agent-A-${CHAIN_KEY}`],
			] as const) {
				const result = await runCli([
					"--json",
					"--data-dir", dir,
					"conversations", "list",
					"--with", peer,
				]);
				expect(result.exitCode).toBe(0);
				const { data } = parseJsonOutput(result.stdout) as {
					data: { conversations: Array<{ messages: number }> };
				};
				expect(data.conversations).toHaveLength(1);
				expect(data.conversations[0]!.messages).toBeGreaterThan(0);
			}
		}, 30_000);
	});

	// ═══════════════════════════════════════════════════════
	// Phase 5: Transfers
	// ═══════════════════════════════════════════════════════

	describe("Phase 5: Transfers", () => {
		it(SCENARIOS.RECORD_BALANCE_BEFORE.name, async () => {
			balanceBeforeTransfer = await getUsdcBalance(agentBAddress, CHAIN_KEY);
			expect(balanceBeforeTransfer).toBeGreaterThan(0n);
		}, 15_000);

		it(SCENARIOS.REQUEST_FUNDS_APPROVED.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentBDir,
				"message", "request-funds",
				`E2E-Agent-A-${CHAIN_KEY}`,
				"--asset", "usdc",
				"--amount", TRANSFER_AMOUNT,
				"--chain", CHAIN!.alias,
				"--note", "e2e approved transfer",
			]);
			expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
		}, 60_000);

		it(SCENARIOS.SYNC_TRANSFER_A.name, async () => {
			// Agent A syncs: grant matches, auto-approves, executes USDC transfer
			await waitForSync({
				dataDir: agentADir,
				description: "Agent A processes transfer request (auto-approve via grant)",
			});
		}, 60_000);

		it(SCENARIOS.SYNC_TRANSFER_RESULT_B.name, async () => {
			// Agent B syncs: receives action/result with tx hash
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receives transfer result",
			});
		}, 60_000);

		it(SCENARIOS.VERIFY_BALANCE_INCREASED.name, async () => {
			const newBalance = await waitForBalanceChange({
				address: agentBAddress,
				chainKey: CHAIN_KEY,
				previousBalance: balanceBeforeTransfer,
				description: "Agent B USDC balance increased after approved transfer",
			});
			const delta = newBalance - balanceBeforeTransfer;
			expect(delta).toBe(TRANSFER_AMOUNT_UNITS);
		}, 30_000);

		it(SCENARIOS.REVOKE_GRANT.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentADir,
				"permissions", "revoke",
				`E2E-Agent-B-${CHAIN_KEY}`,
				"--grant-id", "e2e-usdc-transfer",
				"--note", "e2e revocation",
			]);
			expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
		}, 60_000);

		it(SCENARIOS.SYNC_REVOCATION.name, async () => {
			await waitForPermissions(
				agentBDir,
				`E2E-Agent-A-${CHAIN_KEY}`,
				(data) =>
					data.granted_by_peer.grants.some(
						(g) => g.grantId === "e2e-usdc-transfer" && g.status === "revoked",
					),
			);
		}, 60_000);

		it(SCENARIOS.REQUEST_FUNDS_REJECTED.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir", agentBDir,
				"message", "request-funds",
				`E2E-Agent-A-${CHAIN_KEY}`,
				"--asset", "usdc",
				"--amount", TRANSFER_AMOUNT,
				"--chain", CHAIN!.alias,
				"--note", "e2e rejected transfer",
			]);
			// Request is sent successfully (exit 0), rejection comes as a result
			expect(result.exitCode).toBe(0);
		}, 60_000);

		it(SCENARIOS.SYNC_REJECTION_A.name, async () => {
			// Agent A syncs: no matching grant, auto-rejects
			await waitForSync({
				dataDir: agentADir,
				description: "Agent A processes and rejects transfer request (no grant)",
			});
		}, 60_000);

		it(SCENARIOS.SYNC_REJECTION_RESULT_B.name, async () => {
			// Agent B syncs: receives action/result with rejected status
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receives transfer rejection",
			});
		}, 60_000);

		it(SCENARIOS.VERIFY_BALANCE_UNCHANGED.name, async () => {
			// Small delay to ensure any pending tx would have landed
			await new Promise((r) => setTimeout(r, 3_000));
			const currentBalance = await getUsdcBalance(agentBAddress, CHAIN_KEY);
			const balanceAfterApprovedTransfer = balanceBeforeTransfer + TRANSFER_AMOUNT_UNITS;
			expect(currentBalance).toBe(balanceAfterApprovedTransfer);
		}, 15_000);
	});
}, 600_000); // 10 minute overall timeout

// Re-export for type use in assertions
import type { PermissionSnapshot } from "./helpers.js";
```

- [ ] **Step 2: Verify the file compiles**

Run: `bun run typecheck`

Fix any type errors. Common issues:
- Import paths may need `.js` extension (ESM convention)
- `CHAIN` non-null assertions (`CHAIN!`) are safe because the describe is skipped when CHAIN is undefined
- `viem/chains` may not export `taiko` — check and import from the correct location

- [ ] **Step 3: Run the test locally (dry run)**

Run without env vars to confirm it skips cleanly:

```bash
bun vitest run packages/cli/test/e2e/e2e-live.test.ts
```

Expected: Test suite is skipped (0 tests run, no failures).

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/e2e/e2e-live.test.ts
git commit -m "feat(e2e): add real E2E test for mainnet TAP flows"
```

---

### Task 4: Create the mocked E2E test

**Files:**
- Create: `packages/cli/test/e2e/e2e-mock.test.ts`
- Delete: `packages/cli/test/e2e-two-agent-flow.test.ts`
- Reference: `packages/cli/test/e2e/scenarios.ts` (Task 1)
- Reference: `packages/cli/test/e2e/helpers.ts` (Task 2)
- Reference: `packages/cli/test/helpers/loopback-runtime.ts` (existing)

The mocked E2E mirrors the real E2E scenarios but uses loopback transport. This replaces the old `e2e-two-agent-flow.test.ts`. Key differences from the live test:
- Uses `LoopbackTransportNetwork` instead of real XMTP
- Uses `StaticAgentResolver` instead of on-chain resolution
- Mocks `OwsSigningProvider` with viem test keys
- No registration phase (static resolver handles identity)
- Sync is instant (loopback queues, no polling needed)
- Transfers use fake tx hashes (no on-chain execution)

- [ ] **Step 1: Create the mocked E2E test file**

```typescript
// packages/cli/test/e2e/e2e-mock.test.ts

/**
 * Mocked E2E test — same scenarios as e2e-live.test.ts but with
 * loopback transport, static resolver, and mocked OWS signing.
 *
 * Runs on every PR as part of the normal test suite.
 * No env vars, no network, no cost.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SigningProvider } from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type MessageListenerSession,
	createMessageListenerSession,
} from "../../src/commands/message-listen.js";
import { runCli } from "../helpers/run-cli.js";
import {
	LoopbackTransportNetwork,
	StaticAgentResolver,
	clearLoopbackRuntime,
	createResolvedAgentFixture,
	installLoopbackRuntime,
} from "../helpers/loopback-runtime.js";
import { SCENARIOS } from "./scenarios.js";
import { parseJsonOutput, writeGrantFile } from "./helpers.js";
import type { PermissionSnapshot } from "./helpers.js";

// --- Test keys (Hardhat accounts — no real funds) ---

const AGENT_A_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const AGENT_B_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const AGENT_A_ADDRESS = privateKeyToAccount(AGENT_A_KEY).address;
const AGENT_B_ADDRESS = privateKeyToAccount(AGENT_B_KEY).address;

const CHAIN = "eip155:8453";
const AGENT_A_ID = 7001;
const AGENT_B_ID = 7002;

function createTestSigningProvider(key: `0x${string}`): SigningProvider {
	const account = privateKeyToAccount(key);
	return {
		getAddress: async () => account.address,
		signMessage: async (message) => await account.signMessage({ message }),
		signTypedData: async (params) =>
			await account.signTypedData({
				domain: params.domain as Record<string, unknown>,
				types: params.types as Record<string, readonly { name: string; type: string }[]>,
				primaryType: params.primaryType,
				message: params.message as Record<string, unknown>,
			}),
		signTransaction: async (tx) => await account.signTransaction(tx as never),
		signAuthorization: async () => {
			throw new Error("not implemented in test");
		},
	};
}

const agentASigningProvider = createTestSigningProvider(AGENT_A_KEY);
const agentBSigningProvider = createTestSigningProvider(AGENT_B_KEY);

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: class MockOwsSigningProvider {
			private provider: SigningProvider;
			constructor(wallet: string) {
				this.provider =
					wallet === "agent-b-wallet" ? agentBSigningProvider : agentASigningProvider;
			}
			getAddress() { return this.provider.getAddress(); }
			signMessage(msg: unknown) { return this.provider.signMessage(msg as never); }
			signTypedData(params: unknown) { return this.provider.signTypedData(params as never); }
			signTransaction(tx: unknown) { return this.provider.signTransaction(tx as never); }
			signAuthorization(params: unknown) { return this.provider.signAuthorization(params as never); }
		},
	};
});

async function setOwsConfig(
	dataDir: string,
	walletName: string,
	apiKey: string,
	agentId: number,
): Promise<void> {
	const configPath = join(dataDir, "config.yaml");
	const { default: YAML } = await import("yaml");
	const content = await readFile(configPath, "utf-8");
	const yaml = YAML.parse(content) as Record<string, unknown>;
	yaml.agent_id = agentId;
	yaml.ows = { wallet: walletName, api_key: apiKey };
	await writeFile(configPath, YAML.stringify(yaml), "utf-8");
}

async function waitForPermissionsMock(
	dataDir: string,
	peer: string,
	predicate: (data: PermissionSnapshot) => boolean,
	timeoutMs = 2_000,
): Promise<PermissionSnapshot> {
	const deadline = Date.now() + timeoutMs;
	let lastSnapshot: PermissionSnapshot | undefined;
	while (Date.now() < deadline) {
		const result = await runCli(["--json", "--data-dir", dataDir, "permissions", "show", peer]);
		if (result.exitCode === 0) {
			const { data } = parseJsonOutput(result.stdout) as { data: PermissionSnapshot };
			lastSnapshot = data;
			if (predicate(data)) return data;
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`Timed out waiting for permissions: ${JSON.stringify(lastSnapshot ?? null)}`);
}

describe("E2E mock: loopback two-agent flow", () => {
	let tempRoot: string;
	let agentADir: string;
	let agentBDir: string;
	let agentAListener: MessageListenerSession | undefined;
	let agentBListener: MessageListenerSession | undefined;

	let inviteUrl: string;

	beforeAll(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-e2e-mock-"));
		agentADir = join(tempRoot, "agent-a");
		agentBDir = join(tempRoot, "agent-b");
		await mkdir(agentADir, { recursive: true });
		await mkdir(agentBDir, { recursive: true });

		const resolver = new StaticAgentResolver([
			createResolvedAgentFixture({
				agentId: AGENT_A_ID,
				chain: CHAIN,
				address: AGENT_A_ADDRESS,
				name: "E2E-Agent-A-mock",
				description: "Loopback Agent A",
				capabilities: ["general-chat", "payments"],
			}),
			createResolvedAgentFixture({
				agentId: AGENT_B_ID,
				chain: CHAIN,
				address: AGENT_B_ADDRESS,
				name: "E2E-Agent-B-mock",
				description: "Loopback Agent B",
				capabilities: ["general-chat", "payments"],
			}),
		]);
		const network = new LoopbackTransportNetwork();

		installLoopbackRuntime({
			dataDir: agentADir,
			network,
			resolver,
			txHashPrefix: "a1",
		});
		installLoopbackRuntime({
			dataDir: agentBDir,
			network,
			resolver,
			txHashPrefix: "b2",
		});
	});

	afterAll(async () => {
		await agentBListener?.stop();
		await agentAListener?.stop();
		clearLoopbackRuntime(agentBDir);
		clearLoopbackRuntime(agentADir);
		await rm(tempRoot, { recursive: true, force: true });
	});

	// ═══════════════════════════════════════════════════════
	// Phase 1: Onboarding (mock: init + set OWS config)
	// ═══════════════════════════════════════════════════════

	describe("Phase 1: Onboarding", () => {
		it(SCENARIOS.INIT_AGENT_A.name, async () => {
			const result = await runCli([
				"--plain", "--data-dir", agentADir,
				"init", "--chain", "base",
			]);
			expect(result.exitCode).toBe(0);
			await setOwsConfig(agentADir, "agent-a-wallet", "agent-a-key", AGENT_A_ID);
		});

		it(SCENARIOS.INIT_AGENT_B.name, async () => {
			const result = await runCli([
				"--plain", "--data-dir", agentBDir,
				"init", "--chain", "base",
			]);
			expect(result.exitCode).toBe(0);
			await setOwsConfig(agentBDir, "agent-b-wallet", "agent-b-key", AGENT_B_ID);
		});

		// Registration and balance checks are skipped in mock mode
		// (static resolver and fake transfer executor handle identity + funds)

		it(SCENARIOS.RESOLVE_AGENT_A.name, async () => {
			const result = await runCli([
				"--json", "--data-dir", agentADir,
				"identity", "resolve-self",
			]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as { data: { name: string } };
			expect(data.name).toBe("E2E-Agent-A-mock");
		});

		it(SCENARIOS.RESOLVE_AGENT_B.name, async () => {
			const result = await runCli([
				"--json", "--data-dir", agentBDir,
				"identity", "resolve-self",
			]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as { data: { name: string } };
			expect(data.name).toBe("E2E-Agent-B-mock");
		});
	});

	// ═══════════════════════════════════════════════════════
	// Phase 2: Connection & Trust
	// ═══════════════════════════════════════════════════════

	describe("Phase 2: Connection & Trust", () => {
		it(SCENARIOS.CREATE_INVITE.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentADir, "invite", "create"]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as { data: { url: string } };
			expect(data.url).toBeTruthy();
			inviteUrl = data.url;
		});

		it(SCENARIOS.ACCEPT_INVITE.name, async () => {
			const result = await runCli([
				"--plain", "--data-dir", agentBDir,
				"connect", inviteUrl, "--yes",
			]);
			expect(result.exitCode).toBe(0);
		});

		it(SCENARIOS.SYNC_CONNECTION_A.name, async () => {
			const result = await runCli([
				"--json", "--data-dir", agentADir,
				"message", "sync",
			]);
			expect(result.exitCode).toBe(0);
		});

		it(SCENARIOS.SYNC_CONNECTION_B.name, async () => {
			const result = await runCli([
				"--json", "--data-dir", agentBDir,
				"message", "sync",
			]);
			expect(result.exitCode).toBe(0);
		});

		it(SCENARIOS.VERIFY_CONTACTS_A.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentADir, "contacts", "list"]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as {
				data: { contacts: Array<{ name: string; status: string }> };
			};
			expect(data.contacts).toHaveLength(1);
			expect(data.contacts[0]!.status).toBe("active");
		});

		it(SCENARIOS.VERIFY_CONTACTS_B.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentBDir, "contacts", "list"]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as {
				data: { contacts: Array<{ name: string; status: string }> };
			};
			expect(data.contacts).toHaveLength(1);
			expect(data.contacts[0]!.status).toBe("active");
		});
	});

	// ═══════════════════════════════════════════════════════
	// Phase 3: Permissions & Grants
	// ═══════════════════════════════════════════════════════

	describe("Phase 3: Permissions & Grants", () => {
		it(SCENARIOS.VERIFY_NO_GRANTS.name, async () => {
			const result = await runCli([
				"--json", "--data-dir", agentBDir,
				"permissions", "show", "E2E-Agent-A-mock",
			]);
			expect(result.exitCode).toBe(0);
			const { data } = parseJsonOutput(result.stdout) as { data: PermissionSnapshot };
			expect(data.granted_by_peer.grants).toEqual([]);
		});

		it(SCENARIOS.GRANT_TRANSFER.name, async () => {
			// Start listeners so grant delivery + transfer approval work
			agentAListener = await createMessageListenerSession(
				{ plain: true, dataDir: agentADir },
				{
					approveTransfer: async ({ activeTransferGrants }) =>
						activeTransferGrants.length > 0,
				},
			);
			agentBListener = await createMessageListenerSession(
				{ plain: true, dataDir: agentBDir },
				{},
			);

			const grantFile = await writeGrantFile(agentADir, "e2e-grants.json", [
				{
					grantId: "e2e-usdc-transfer",
					scope: "transfer/request",
					constraints: {
						asset: "native",
						chain: CHAIN,
						maxAmount: "0.001",
					},
				},
			]);
			const result = await runCli([
				"--plain", "--data-dir", agentADir,
				"permissions", "grant", "E2E-Agent-B-mock",
				"--file", grantFile,
				"--note", "e2e mock grant",
			]);
			expect(result.exitCode).toBe(0);
		});

		it(SCENARIOS.VERIFY_GRANT.name, async () => {
			const perms = await waitForPermissionsMock(
				agentBDir,
				"E2E-Agent-A-mock",
				(data) =>
					data.granted_by_peer.grants.some(
						(g) => g.grantId === "e2e-usdc-transfer" && g.status === "active",
					),
			);
			expect(
				perms.granted_by_peer.grants.find((g) => g.grantId === "e2e-usdc-transfer")?.status,
			).toBe("active");
		});
	});

	// ═══════════════════════════════════════════════════════
	// Phase 4: Messaging
	// ═══════════════════════════════════════════════════════

	describe("Phase 4: Messaging", () => {
		it(SCENARIOS.SEND_MESSAGE_A_TO_B.name, async () => {
			const result = await runCli([
				"--plain", "--data-dir", agentADir,
				"message", "send", "E2E-Agent-B-mock",
				"ping from agent A", "--scope", "general-chat",
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Sent:");
		});

		it(SCENARIOS.SEND_MESSAGE_B_TO_A.name, async () => {
			const result = await runCli([
				"--plain", "--data-dir", agentBDir,
				"message", "send", "E2E-Agent-A-mock",
				"pong from agent B", "--scope", "general-chat",
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Sent:");
		});

		it(SCENARIOS.VERIFY_CONVERSATIONS.name, async () => {
			for (const [dir, peer] of [
				[agentADir, "E2E-Agent-B-mock"],
				[agentBDir, "E2E-Agent-A-mock"],
			] as const) {
				const result = await runCli([
					"--json", "--data-dir", dir,
					"conversations", "list", "--with", peer,
				]);
				expect(result.exitCode).toBe(0);
				const { data } = parseJsonOutput(result.stdout) as {
					data: { conversations: Array<{ messages: number }> };
				};
				expect(data.conversations).toHaveLength(1);
				expect(data.conversations[0]!.messages).toBeGreaterThan(0);
			}
		});
	});

	// ═══════════════════════════════════════════════════════
	// Phase 5: Transfers
	// ═══════════════════════════════════════════════════════

	describe("Phase 5: Transfers", () => {
		it(SCENARIOS.REQUEST_FUNDS_APPROVED.name, async () => {
			const result = await runCli([
				"--plain", "--data-dir", agentBDir,
				"message", "request-funds", "E2E-Agent-A-mock",
				"--asset", "native",
				"--amount", "0.0002",
				"--chain", "base",
				"--note", "e2e approved request",
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("completed");
			// Fake tx hash from loopback
			expect(result.stdout).toContain("0xa100000000000000000000000000000000000000000000000000000000000000");
		});

		it(SCENARIOS.REVOKE_GRANT.name, async () => {
			const result = await runCli([
				"--plain", "--data-dir", agentADir,
				"permissions", "revoke", "E2E-Agent-B-mock",
				"--grant-id", "e2e-usdc-transfer",
				"--note", "e2e mock revocation",
			]);
			expect(result.exitCode).toBe(0);
		});

		it(SCENARIOS.SYNC_REVOCATION.name, async () => {
			const perms = await waitForPermissionsMock(
				agentBDir,
				"E2E-Agent-A-mock",
				(data) =>
					data.granted_by_peer.grants.some(
						(g) => g.grantId === "e2e-usdc-transfer" && g.status === "revoked",
					),
			);
			expect(
				perms.granted_by_peer.grants.find((g) => g.grantId === "e2e-usdc-transfer")?.status,
			).toBe("revoked");
		});

		it(SCENARIOS.REQUEST_FUNDS_REJECTED.name, async () => {
			const result = await runCli([
				"--plain", "--data-dir", agentBDir,
				"message", "request-funds", "E2E-Agent-A-mock",
				"--asset", "native",
				"--amount", "0.0001",
				"--chain", "base",
				"--note", "e2e rejected request",
			]);
			// Rejection: exit code 3 or 0 depending on timing
			expect([0, 3]).toContain(result.exitCode);
			if (result.exitCode === 3) {
				expect(result.stderr).toContain("Action rejected by agent");
			}
		});
	});
}, 20_000);
```

- [ ] **Step 2: Delete the old E2E test file**

```bash
rm packages/cli/test/e2e-two-agent-flow.test.ts
```

- [ ] **Step 3: Run the mocked E2E test**

```bash
bun vitest run packages/cli/test/e2e/e2e-mock.test.ts
```

Expected: All tests pass. If any fail, debug and fix before committing.

Pay close attention to:
- The mocked E2E uses `native` asset for transfers (matching the original test), not `usdc`
- Listener sessions need to be started before grants for the transfer auto-approval to work
- The mock agent names are `E2E-Agent-A-mock` / `E2E-Agent-B-mock` (must match resolver fixtures)
- The `SYNC_GRANT` scenario from scenarios.ts is handled implicitly by the listener in mock mode — if the `waitForPermissionsMock` in `VERIFY_GRANT` passes, the sync worked

- [ ] **Step 4: Run the full test suite to verify nothing is broken**

```bash
bun run test
```

Expected: All existing tests plus the new mock E2E pass. The old `e2e-two-agent-flow` tests are gone; the new `e2e-mock` covers the same scenarios.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/e2e/e2e-mock.test.ts
git rm packages/cli/test/e2e-two-agent-flow.test.ts
git commit -m "feat(e2e): add mocked E2E aligned with live scenarios, delete old E2E"
```

---

### Task 5: Update the release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Rewrite the release workflow**

The workflow changes:
1. Add `workflow_dispatch` trigger with `skip_publish` input
2. Split into separate jobs: `validate`, `build-and-test`, `e2e` (matrix), `publish`
3. The `e2e` job runs per-chain as a release gate
4. `publish` depends on `e2e` passing and only runs on tag push (not manual dispatch with skip)

Read the current `release.yml` and replace it with:

```yaml
name: Release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:
    inputs:
      skip_publish:
        description: "Run E2E only, skip npm publish"
        type: boolean
        default: true

permissions:
  contents: write
  id-token: write

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  validate:
    name: Validate & Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run build
      - run: bun run test

      - name: Validate version
        if: startsWith(github.ref, 'refs/tags/v')
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          for pkg in packages/core/package.json packages/cli/package.json packages/openclaw-plugin/package.json; do
            PKG_VERSION=$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('$pkg','utf8')).version)")
            if [[ "$PKG_VERSION" != "$TAG_VERSION" ]]; then
              echo "::error::Version mismatch: $pkg has $PKG_VERSION but tag is v$TAG_VERSION"
              exit 1
            fi
          done
          echo "All packages at version $TAG_VERSION"

  e2e:
    name: E2E (${{ matrix.chain }})
    needs: [validate]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        chain: [base, taiko]
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build

      - name: Install OWS
        run: curl -fsSL https://docs.openwallet.sh/install.sh | bash

      - name: Run E2E tests (${{ matrix.chain }})
        run: bun vitest run packages/cli/test/e2e/e2e-live.test.ts --reporter=verbose
        env:
          E2E_CHAIN: ${{ matrix.chain }}
          E2E_AGENT_A_OWS_WALLET: ${{ secrets.E2E_AGENT_A_OWS_WALLET }}
          E2E_AGENT_A_OWS_API_KEY: ${{ secrets.E2E_AGENT_A_OWS_API_KEY }}
          E2E_AGENT_B_OWS_WALLET: ${{ secrets.E2E_AGENT_B_OWS_WALLET }}
          E2E_AGENT_B_OWS_API_KEY: ${{ secrets.E2E_AGENT_B_OWS_API_KEY }}

  publish:
    name: Publish to npm
    needs: [e2e]
    if: startsWith(github.ref, 'refs/tags/v') && (inputs.skip_publish != true)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build

      - name: Bundle skills into OpenClaw plugin
        run: |
          rm -rf packages/openclaw-plugin/skills
          mkdir -p packages/openclaw-plugin/skills
          cp -r skills/trusted-agents packages/openclaw-plugin/skills/trusted-agents

      - name: Verify release package metadata
        run: bun run verify:release

      - name: Resolve workspace dependencies
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          for pkg in packages/cli/package.json packages/openclaw-plugin/package.json; do
            node -e "
              const fs = require('fs');
              const pkg = JSON.parse(fs.readFileSync('$pkg', 'utf8'));
              let changed = false;
              for (const [dep, ver] of Object.entries(pkg.dependencies || {})) {
                if (typeof ver === 'string' && ver.startsWith('workspace:')) {
                  pkg.dependencies[dep] = '$TAG_VERSION';
                  changed = true;
                }
              }
              if (changed) {
                fs.writeFileSync('$pkg', JSON.stringify(pkg, null, 2) + '\n');
                console.log('Resolved workspace deps in $pkg to $TAG_VERSION');
              }
            "
          done

      - name: Verify tarballs
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          cd packages/core && bun pm pack --dry-run && cd ../..
          for pkg_dir in packages/cli packages/openclaw-plugin; do
            cd "$pkg_dir"
            bun pm pack --dry-run
            TARBALL=$(bun pm pack 2>&1 | grep '\.tgz$')
            tar -xzf "$TARBALL"
            CORE_DEP=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package/package.json','utf8')).dependencies['trusted-agents-core'] || 'MISSING')")
            rm -rf package "$TARBALL"
            if [[ "$CORE_DEP" != "$TAG_VERSION" ]]; then
              echo "::error::$pkg_dir has trusted-agents-core@$CORE_DEP but expected $TAG_VERSION"
              exit 1
            fi
            echo "$pkg_dir: trusted-agents-core@$CORE_DEP ✓"
            cd ../..
          done

      - name: Configure npm
        run: echo "//registry.npmjs.org/:_authToken=${{ secrets.NPM_TOKEN }}" > ~/.npmrc

      - name: Publish trusted-agents-core
        working-directory: packages/core
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          if npm view "trusted-agents-core@$TAG_VERSION" version 2>/dev/null; then
            echo "trusted-agents-core@$TAG_VERSION already published, skipping"
          else
            bun publish --access public --no-git-checks --provenance
          fi
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Publish trusted-agents-cli
        working-directory: packages/cli
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          if npm view "trusted-agents-cli@$TAG_VERSION" version 2>/dev/null; then
            echo "trusted-agents-cli@$TAG_VERSION already published, skipping"
          else
            bun publish --access public --no-git-checks --provenance
          fi
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Publish trusted-agents-tap
        working-directory: packages/openclaw-plugin
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          if npm view "trusted-agents-tap@$TAG_VERSION" version 2>/dev/null; then
            echo "trusted-agents-tap@$TAG_VERSION already published, skipping"
          else
            bun publish --access public --no-git-checks --provenance
          fi
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        run: |
          if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
            echo "Release $GITHUB_REF_NAME already exists, skipping"
          else
            gh release create "$GITHUB_REF_NAME" --generate-notes
          fi
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Validate the YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "YAML valid"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add E2E release gate with chain matrix and manual trigger"
```

---

### Task 6: Cleanup and documentation

**Files:**
- Delete: `LIVE_SMOKE_RUNBOOK.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Delete the smoke runbook**

```bash
git rm LIVE_SMOKE_RUNBOOK.md
```

- [ ] **Step 2: Update CLAUDE.md E2E maintenance section**

Find the section titled "Deterministic E2E Maintenance" in `CLAUDE.md` and replace it. The new section should reference both E2E test files and explain when to update each.

Replace the existing section (starting with `## Deterministic E2E Maintenance`) with:

```markdown
## E2E Test Maintenance

Two E2E test files cover the same scenarios:

- **`packages/cli/test/e2e/e2e-live.test.ts`** — Real E2E against mainnet (XMTP, OWS, on-chain). Runs as a release gate.
- **`packages/cli/test/e2e/e2e-mock.test.ts`** — Mocked E2E with loopback transport. Runs on every PR.
- **`packages/cli/test/e2e/scenarios.ts`** — Canonical scenario list shared by both.
- **`packages/cli/test/e2e/helpers.ts`** — Shared assertion and polling utilities.

Update both test files whenever there is a meaningful behavioral change. A change counts as meaningful if it changes any of:
- protocol method names or payload fields
- CLI command names, flags, or required sequencing for `invite`, `connect`, `permissions`, `message`, `contacts`, or `conversations`
- trust/contact persistence shape
- directional grant schema or ledger schema
- listener approval behavior or action request/response semantics
- transfer execution semantics
- multi-agent `dataDir` isolation behavior

A change does **not** count as meaningful if it is only:
- formatting, comments, or copy-only docs with no behavioral change
- internal refactors that preserve observable CLI/protocol behavior

### Live E2E secrets
The real E2E uses 4 GitHub Actions secrets:
- `E2E_AGENT_A_OWS_WALLET` / `E2E_AGENT_A_OWS_API_KEY` — Agent A OWS wallet
- `E2E_AGENT_B_OWS_WALLET` / `E2E_AGENT_B_OWS_API_KEY` — Agent B OWS wallet

Both wallets have policies for Base (`eip155:8453`) and Taiko (`eip155:167000`).
Fund the wallet addresses with USDC on both chains. The tests fail-fast if balance < 0.50 USDC.
```

- [ ] **Step 3: Also remove the `LIVE_SMOKE_RUNBOOK.md` reference from the CLAUDE.md section about live smoke**

Search for any mention of `LIVE_SMOKE_RUNBOOK.md` in `CLAUDE.md` and remove those lines. There's a line that says:
```
- The live XMTP/mainnet smoke runbook is `LIVE_SMOKE_RUNBOOK.md`. Update it when the real-world setup, required secrets, or operational flow changes.
```

Delete that line.

- [ ] **Step 4: Run full test suite one more time**

```bash
bun run test
```

Expected: All tests pass (unit tests + new mock E2E).

- [ ] **Step 5: Commit**

```bash
git rm LIVE_SMOKE_RUNBOOK.md
git add CLAUDE.md
git commit -m "chore: delete smoke runbook, update CLAUDE.md for new E2E structure"
```

---

### Task 7: Verification and final integration check

- [ ] **Step 1: Run typecheck**

```bash
bun run typecheck
```

Expected: No type errors across all packages.

- [ ] **Step 2: Run lint**

```bash
bun run lint
```

Expected: No lint errors. Fix any formatting issues with `bun run lint:fix`.

- [ ] **Step 3: Run full test suite**

```bash
bun run test
```

Expected: All tests pass.

- [ ] **Step 4: Verify the live E2E skips gracefully without env vars**

```bash
bun vitest run packages/cli/test/e2e/e2e-live.test.ts --reporter=verbose
```

Expected: Suite is skipped with no failures.

- [ ] **Step 5: (Optional) Run the live E2E locally against Base**

If OWS is installed locally and wallets are funded:

```bash
E2E_CHAIN=base \
E2E_AGENT_A_OWS_WALLET=e2e-agent-a \
E2E_AGENT_B_OWS_WALLET=e2e-agent-b \
bun vitest run packages/cli/test/e2e/e2e-live.test.ts --reporter=verbose
```

Expected: Full flow runs (3-5 minutes). All phases pass.

Note: This will fail if wallets haven't been funded with USDC yet or OWS wallets are not in the local vault.

- [ ] **Step 6: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix(e2e): integration fixes from verification pass"
```
