# Live E2E Reliability Improvements

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live E2E test suite (`e2e-live.test.ts`) less fragile, faster to diagnose, and enable parallel chain execution in CI.

**Architecture:** Eight targeted improvements to the existing test infrastructure. No new files — all changes land in 4 existing files. Changes are layered: helpers first, then scenarios, then the test file, then CI workflow.

**Tech Stack:** Vitest 3.x, viem, GitHub Actions

---

### Task 1: Add configurable RPC URLs and new helpers to `helpers.ts`

**Files:**
- Modify: `packages/cli/test/e2e/helpers.ts`

- [ ] **Step 1: Make RPC URLs configurable via env vars**

In `CHAIN_CONFIGS`, replace hardcoded `rpcUrl` values with env var fallbacks:

```ts
export const CHAIN_CONFIGS: Record<string, ChainE2EConfig> = {
	base: {
		caip2: "eip155:8453",
		alias: "base",
		rpcUrl: process.env.E2E_BASE_RPC_URL ?? "https://mainnet.base.org",
		usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		usdcDecimals: 6,
	},
	taiko: {
		caip2: "eip155:167000",
		alias: "taiko",
		rpcUrl: process.env.E2E_TAIKO_RPC_URL ?? "https://rpc.mainnet.taiko.xyz",
		usdcAddress: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
		usdcDecimals: 6,
	},
};
```

- [ ] **Step 2: Add `waitForStableBaseline` helper**

Add after the `waitForContact` function (after line 304):

```ts
/**
 * Sync until the XMTP baseline is stable (two consecutive syncs with 0 new messages).
 * Prevents the first real message from being swallowed by an incomplete baseline.
 */
export async function waitForStableBaseline(
	dataDir: string,
	label: string,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	// Initial sync to establish checkpoints
	await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);

	// Poll until a sync returns 0 processed messages (baseline is stable)
	while (Date.now() < deadline) {
		const result = await runCli(["--json", "--data-dir", dataDir, "message", "sync"]);
		if (result.exitCode === 0) {
			try {
				const parsed = parseJsonOutput(result.stdout);
				const data = parsed.data as { processed?: number };
				if ((data.processed ?? 0) === 0) return;
			} catch {
				// Parse error — keep polling
			}
		}
		await new Promise((r) => setTimeout(r, 2_000));
	}

	throw new Error(`${label} XMTP baseline did not stabilize within ${timeoutMs}ms`);
}
```

- [ ] **Step 3: Add `createPhaseTimer` helper**

Add after `waitForStableBaseline`:

```ts
/**
 * Simple phase-level timer for CI telemetry.
 * Usage: `const timer = createPhaseTimer("Phase 1"); beforeAll(timer.start); afterAll(timer.stop);`
 */
export function createPhaseTimer(name: string): { start: () => void; stop: () => void } {
	let startTime: number;
	return {
		start() {
			startTime = Date.now();
		},
		stop() {
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			console.log(`[timing] ${name}: ${elapsed}s`);
		},
	};
}
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

---

### Task 2: Add preflight scenarios to `scenarios.ts`

**Files:**
- Modify: `packages/cli/test/e2e/scenarios.ts`

- [ ] **Step 1: Add preflight scenario entries**

Add after the existing `VALIDATE_ENV` entry in the `SCENARIOS` object:

```ts
PREFLIGHT_RPC: { name: "Verify chain RPC is reachable", phase: PHASES.PREFLIGHT },
PREFLIGHT_OWS: { name: "Verify OWS is available", phase: PHASES.PREFLIGHT },
```

---

### Task 3: Implement all live E2E test improvements

**Files:**
- Modify: `packages/cli/test/e2e/e2e-live.test.ts`

- [ ] **Step 1: Update imports**

Add `onTestFailed` to the vitest import. Add `execFileSync` from `node:child_process`. Add new helpers:

Change the vitest import from:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
```
to:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
```

Add at the top of the file (with the other node imports):
```ts
import { execFileSync } from "node:child_process";
```

Add `createPhaseTimer` and `waitForStableBaseline` to the helpers import:
```ts
import {
	type PermissionSnapshot,
	CHAIN_CONFIGS,
	createPhaseTimer,
	formatUsdc,
	getUsdcBalance,
	parseJsonOutput,
	readAgentBalanceSnapshot,
	requireEnv,
	waitForBalanceChange,
	waitForContact,
	waitForPermissions,
	waitForStableBaseline,
	waitForSync,
	writeGrantFile,
} from "./helpers.js";
```

- [ ] **Step 2: Add bail-out mechanism**

Inside the top-level `describe.skipIf(SKIP)(...)`, immediately after the `afterAll` block, add:

```ts
// ── Bail-out: skip remaining tests after the first failure ───────────
let suiteFailed = false;

beforeEach(({ skip }) => {
	if (suiteFailed) skip();
	onTestFailed(() => {
		suiteFailed = true;
	});
});
```

- [ ] **Step 3: Add Phase 0: Preflight**

Add a new describe block between the bail-out mechanism and Phase 1:

```ts
// ── Phase 0: Preflight ───────────────────────────────────────────────

describe("Phase 0: Preflight", () => {
	const timer = createPhaseTimer("Phase 0: Preflight");
	beforeAll(timer.start);
	afterAll(timer.stop);

	it(SCENARIOS.PREFLIGHT_RPC.name, { timeout: 15_000 }, async () => {
		try {
			await getUsdcBalance(
				"0x0000000000000000000000000000000000000001",
				CHAIN_KEY,
			);
		} catch (err) {
			throw new Error(
				`Chain RPC for ${CHAIN_KEY} (${CHAIN.rpcUrl}) is not reachable. ` +
					`E2E tests require a working RPC endpoint. ` +
					`Override with E2E_${CHAIN_KEY.toUpperCase()}_RPC_URL env var. ` +
					`Error: ${(err as Error).message}`,
			);
		}
	});

	it(SCENARIOS.PREFLIGHT_OWS.name, { timeout: 15_000 }, async () => {
		try {
			execFileSync("ows", ["wallet", "list"], {
				timeout: 10_000,
				stdio: "pipe",
			});
		} catch (err) {
			throw new Error(
				`OWS is not available or not installed. ` +
					`E2E tests require OWS for wallet signing. ` +
					`Error: ${(err as Error).message}`,
			);
		}
	});
});
```

- [ ] **Step 4: Add phase timers to all existing phases**

Add to each existing `describe("Phase N: ...")` block:

```ts
const timer = createPhaseTimer("Phase N: <Name>");
beforeAll(timer.start);
afterAll(timer.stop);
```

For: Phase 1 (Onboarding), Phase 2 (Connection), Phase 3 (Permissions), Phase 4 (Messaging), Phase 5 (Transfers).

- [ ] **Step 5: Replace XMTP baseline with stable baseline**

Replace the existing baseline test in Phase 2:

```ts
it("Establish XMTP baseline for both agents", { timeout: 60_000 }, async () => {
	await runCli(["--json", "--data-dir", agentADir, "message", "sync"]);
	await runCli(["--json", "--data-dir", agentBDir, "message", "sync"]);
});
```

With:

```ts
it("Establish XMTP baseline for both agents", { timeout: 60_000 }, async () => {
	await waitForStableBaseline(agentADir, "Agent A", 30_000);
	await waitForStableBaseline(agentBDir, "Agent B", 30_000);
});
```

- [ ] **Step 6: Add listener startup guard**

After `createMessageListenerSession` in the listener start test, add a stabilization delay:

```ts
// Allow XMTP stream subscription to fully establish before sending messages.
// Without this, messages sent immediately after start() may land in the
// XMTP mailbox before the stream listener is ready, requiring a manual
// reconcile that this test flow does not perform.
await new Promise((r) => setTimeout(r, 3_000));
```

- [ ] **Step 7: Fix balance delta assertion**

Replace the exact match:
```ts
).toBe(TRANSFER_AMOUNT_UNITS);
```

With a minimum-threshold check:
```ts
expect(
	delta >= TRANSFER_AMOUNT_UNITS,
	`Agent B balance should have increased by at least ${TRANSFER_AMOUNT} USDC (${TRANSFER_AMOUNT_UNITS} units). ` +
		`Before: ${formatUsdc(balanceBeforeTransfer, CHAIN_KEY)}, After: ${formatUsdc(balanceAfterTransfer, CHAIN_KEY)}, ` +
		`Delta: ${formatUsdc(delta, CHAIN_KEY)}`,
).toBe(true);
```

- [ ] **Step 8: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

---

### Task 4: Enable parallel chain execution in CI

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Remove serial execution constraint**

Remove the `max-parallel: 1` line from the e2e job strategy. The two chains use separate temp dirs and agent IDs. XMTP messages from parallel runs are filtered by sender identity in each run's independent trust store.

Before:
```yaml
    strategy:
      fail-fast: false
      max-parallel: 1
      matrix:
        chain: [base, taiko]
```

After:
```yaml
    strategy:
      fail-fast: false
      matrix:
        chain: [base, taiko]
```

---

### Task 5: Verify and commit

- [ ] **Step 1: Run full verification**

```bash
bun run typecheck
bun run lint
bun run test
```

All three must pass.

- [ ] **Step 2: Commit all changes**

```bash
git add packages/cli/test/e2e/helpers.ts packages/cli/test/e2e/scenarios.ts packages/cli/test/e2e/e2e-live.test.ts .github/workflows/release.yml
git commit -m "test(e2e): improve live E2E reliability, add preflight checks and phase telemetry

- Add phase-level bail-out to skip remaining tests after first failure
- Add Phase 0 preflight checks (chain RPC + OWS availability)
- Replace single XMTP baseline sync with stable-baseline polling
- Add listener startup stabilization delay
- Use >= threshold for balance delta (tolerates concurrent deposits)
- Add per-phase timing telemetry for CI diagnostics
- Make RPC URLs configurable via E2E_BASE_RPC_URL / E2E_TAIKO_RPC_URL
- Enable parallel base/taiko execution in release workflow"
```
