import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnits } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { type InProcessTapd, startInProcessTapd } from "../helpers/in-process-tapd.ts";
import { runCli } from "../helpers/run-cli.js";
import {
	type AgentSession,
	CHAIN_CONFIGS,
	type PermissionSnapshot,
	createAgentSession,
	createPhaseTimer,
	formatUsdc,
	getUsdcBalance,
	parseJsonOutput,
	readAgentBalanceSnapshot,
	requireEnv,
	waitForBalanceChange,
	waitForContact,
	waitForConversationMessage,
	waitForPermissions,
	waitForStableBaseline,
	writeGrantFile,
} from "./helpers.js";
import { SCENARIOS } from "./scenarios.js";

// ── Skip logic ────────────────────────────────────────────────────────────────

const SKIP = !process.env.E2E_AGENT_A_OWS_WALLET;

// ── Chain config ──────────────────────────────────────────────────────────────

const CHAIN_KEY = (process.env.E2E_CHAIN ?? "base").toLowerCase();

if (!SKIP && !CHAIN_CONFIGS[CHAIN_KEY]) {
	throw new Error(
		`Unknown E2E_CHAIN value: "${CHAIN_KEY}". Valid keys: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
	);
}

const CHAIN = CHAIN_CONFIGS[CHAIN_KEY] ?? CHAIN_CONFIGS.base!;

// ── Agent naming ──────────────────────────────────────────────────────────────

const AGENT_A_NAME = `E2E-Agent-A-${CHAIN_KEY}`;
const AGENT_B_NAME = `E2E-Agent-B-${CHAIN_KEY}`;

// ── Transfer amount ───────────────────────────────────────────────────────────

const TRANSFER_AMOUNT = "0.001";
const TRANSFER_AMOUNT_UNITS = parseUnits(TRANSFER_AMOUNT, CHAIN.usdcDecimals);
const MIN_BALANCE_UNITS = parseUnits("0.50", CHAIN.usdcDecimals);
const GRANT_ID = "e2e-usdc-transfer";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Retry resolve-self to handle RPC propagation lag after on-chain registration. */
async function retryResolve(
	dataDir: string,
	agentName: string,
	maxAttempts = 5,
	delayMs = 3_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	let lastResult: { stdout: string; stderr: string; exitCode: number } | undefined;
	for (let i = 0; i < maxAttempts; i++) {
		const result = await runCli(["--json", "--data-dir", dataDir, "identity", "resolve-self"]);
		lastResult = result;
		if (result.exitCode === 0) return result;
		if (i < maxAttempts - 1) {
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}
	throw new Error(
		`resolve-self for ${agentName} failed after ${maxAttempts} attempts.\n` +
			`stdout: ${lastResult?.stdout}\nstderr: ${lastResult?.stderr}`,
	);
}

// ── Shared state (mutated across test phases) ─────────────────────────────────

let tempRoot: string;
let agentADir: string;
let agentBDir: string;
let agentBAddress: `0x${string}`;
let inviteUrl: string;
let balanceBeforeTransfer: bigint;
let balanceAfterTransfer: bigint;
let agentATapd: InProcessTapd | undefined;
let agentBTapd: InProcessTapd | undefined;
let sessionA: AgentSession | undefined;
let sessionB: AgentSession | undefined;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("TAP live E2E — real XMTP + OWS + on-chain", { timeout: 600_000 }, () => {
	beforeAll(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-e2e-live-"));
		agentADir = join(tempRoot, "agent-a");
		agentBDir = join(tempRoot, "agent-b");
		await mkdir(agentADir, { recursive: true });
		await mkdir(agentBDir, { recursive: true });

		// If a cached XMTP DB dir is available (CI), symlink each agent's xmtp/
		// dir to the cache so the same XMTP installation is reused across runs.
		// This avoids exhausting the 10-per-inbox installation limit.
		const xmtpCacheDir = process.env.E2E_XMTP_DB_CACHE;
		if (xmtpCacheDir) {
			for (const [dir, label] of [
				[agentADir, "agent-a"],
				[agentBDir, "agent-b"],
			] as const) {
				const cacheTarget = join(xmtpCacheDir, label, "xmtp");
				await mkdir(cacheTarget, { recursive: true });
				await symlink(cacheTarget, join(dir, "xmtp"));
			}
		}
	});

	afterAll(async () => {
		await agentBTapd?.stop();
		await agentATapd?.stop();
		await sessionA?.stop();
		await sessionB?.stop();
		if (tempRoot) {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	// ── Bail-out: skip remaining tests after the first failure ───────────────

	let suiteFailed = false;

	beforeEach(({ skip }) => {
		if (suiteFailed) skip();
		onTestFailed(() => {
			suiteFailed = true;
		});
	});

	// ── Phase 0: Preflight ───────────────────────────────────────────────────

	describe("Phase 0: Preflight", () => {
		const timer = createPhaseTimer("Phase 0: Preflight");
		beforeAll(timer.start);
		afterAll(timer.stop);

		it(SCENARIOS.PREFLIGHT_RPC.name, { timeout: 15_000 }, async () => {
			try {
				await getUsdcBalance("0x0000000000000000000000000000000000000001", CHAIN_KEY);
			} catch (err) {
				throw new Error(
					`Chain RPC for ${CHAIN_KEY} (${CHAIN.rpcUrl}) is not reachable. E2E tests require a working RPC endpoint. Override with E2E_${CHAIN_KEY.toUpperCase()}_RPC_URL env var. Error: ${(err as Error).message}`,
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
					`OWS is not available or not installed. E2E tests require OWS for wallet signing. Error: ${(err as Error).message}`,
				);
			}
		});
	});

	// ── Phase 1: Onboarding ───────────────────────────────────────────────────

	describe("Phase 1: Onboarding", () => {
		const timer = createPhaseTimer("Phase 1: Onboarding");
		beforeAll(timer.start);
		afterAll(timer.stop);

		it(SCENARIOS.INIT_AGENT_A.name, { timeout: 120_000 }, async () => {
			const walletA = requireEnv("E2E_AGENT_A_OWS_WALLET");

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"init",
				"--chain",
				CHAIN.alias,
				"--wallet",
				walletA,
				"--non-interactive",
			]);

			expect(result.exitCode, `Agent A init failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.INIT_AGENT_B.name, { timeout: 120_000 }, async () => {
			const walletB = requireEnv("E2E_AGENT_B_OWS_WALLET");

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"init",
				"--chain",
				CHAIN.alias,
				"--wallet",
				walletB,
				"--non-interactive",
			]);

			expect(result.exitCode, `Agent B init failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.BALANCE_CHECK_A.name, { timeout: 15_000 }, async () => {
			const balance = await readAgentBalanceSnapshot(agentADir, CHAIN.alias);

			expect(
				balance.fundingUsdcBalance >= MIN_BALANCE_UNITS,
				`Agent A funding account (${balance.fundingAddress}) has insufficient USDC balance on ${CHAIN.alias}. Found: ${formatUsdc(balance.fundingUsdcBalance, CHAIN_KEY)} USDC. Required: at least 0.50 USDC. Messaging: ${balance.messagingAddress}. Execution: ${balance.executionAddress}. Please fund the actual funding account before running the live E2E test.`,
			).toBe(true);
		});

		it(SCENARIOS.BALANCE_CHECK_B.name, { timeout: 15_000 }, async () => {
			const balance = await readAgentBalanceSnapshot(agentBDir, CHAIN.alias);
			agentBAddress = balance.messagingAddress;

			expect(
				balance.fundingUsdcBalance >= MIN_BALANCE_UNITS,
				`Agent B funding account (${balance.fundingAddress}) has insufficient USDC balance on ${CHAIN.alias}. Found: ${formatUsdc(balance.fundingUsdcBalance, CHAIN_KEY)} USDC. Required: at least 0.50 USDC. Messaging: ${balance.messagingAddress}. Execution: ${balance.executionAddress}. Please fund the actual funding account before running the live E2E test.`,
			).toBe(true);
		});

		it(SCENARIOS.REGISTER_AGENT_A.name, { timeout: 120_000 }, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"register",
				"create",
				"--name",
				AGENT_A_NAME,
				"--description",
				"E2E test agent A",
				"--capabilities",
				"general-chat,payments",
			]);

			expect(result.exitCode, `Agent A register failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.REGISTER_AGENT_B.name, { timeout: 120_000 }, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"register",
				"create",
				"--name",
				AGENT_B_NAME,
				"--description",
				"E2E test agent B",
				"--capabilities",
				"general-chat,payments",
			]);

			expect(result.exitCode, `Agent B register failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.RESOLVE_AGENT_A.name, { timeout: 30_000 }, async () => {
			const result = await retryResolve(agentADir, AGENT_A_NAME);
			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { name: string; agentAddress: string };

			expect(data.name, "Agent A resolved name should match registered name").toBe(AGENT_A_NAME);
		});

		it(SCENARIOS.RESOLVE_AGENT_B.name, { timeout: 30_000 }, async () => {
			const result = await retryResolve(agentBDir, AGENT_B_NAME);
			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { name: string; agentAddress: string };

			expect(data.name, "Agent B resolved name should match registered name").toBe(AGENT_B_NAME);
		});
	});

	// ── Phase 2: Connection ───────────────────────────────────────────────────

	describe("Phase 2: Connection", () => {
		const timer = createPhaseTimer("Phase 2: Connection");
		beforeAll(timer.start);
		afterAll(timer.stop);

		it("Start in-process tapd for both agents", { timeout: 60_000 }, async () => {
			// Phase 3: every CLI command goes through tapd's HTTP API. We spin
			// up an in-process Daemon per agent against the real OWS-backed
			// runtime so the production code path is exercised end to end.
			// The transfer auto-approve hook is wired here too so the test
			// no longer needs a separate listener pass.
			agentATapd = await startInProcessTapd({
				dataDir: agentADir,
				approveTransfer: async ({ activeTransferGrants }) => activeTransferGrants.length > 0,
			});
			agentBTapd = await startInProcessTapd({
				dataDir: agentBDir,
			});
		});

		// XMTP baselines existing DM history on the first sync.
		// Both agents must sync once BEFORE any messages are sent,
		// otherwise the first real message gets baselined (ignored).
		it("Establish XMTP baseline for both agents", { timeout: 120_000 }, async () => {
			await waitForStableBaseline(agentADir, "Agent A", 30_000, sessionA?.runtime);
			await waitForStableBaseline(agentBDir, "Agent B", 30_000, sessionB?.runtime);
		});

		it(SCENARIOS.CREATE_INVITE.name, { timeout: 60_000 }, async () => {
			const result = await runCli(["--json", "--data-dir", agentADir, "invite", "create"]);

			expect(result.exitCode, `Agent A invite create failed:\n${result.stderr}`).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { url: string };

			expect(data.url, "Invite URL should be defined").toBeTruthy();
			inviteUrl = data.url;
		});

		it(SCENARIOS.ACCEPT_INVITE.name, { timeout: 60_000 }, async () => {
			expect(inviteUrl, "Invite URL must be set from previous test").toBeTruthy();

			// Stop sessionB to release the transport lock before connect
			await sessionB?.stop();
			sessionB = undefined;

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"connect",
				inviteUrl,
				"--no-wait",
			]);

			expect(result.exitCode, `Agent B connect failed:\n${result.stderr}`).toBe(0);

			// Restart sessionB after connect
			sessionB = await createAgentSession({ dataDir: agentBDir });
		});

		it(SCENARIOS.VERIFY_CONTACTS_A.name, { timeout: 60_000 }, async () => {
			// Polls sync + contacts until Agent B appears as active
			await waitForContact({
				dataDir: agentADir,
				peerName: AGENT_B_NAME,
				timeoutMs: 60_000,
				runtime: sessionA?.runtime,
			});
		});

		it(SCENARIOS.VERIFY_CONTACTS_B.name, { timeout: 60_000 }, async () => {
			await waitForContact({
				dataDir: agentBDir,
				peerName: AGENT_A_NAME,
				timeoutMs: 60_000,
				runtime: sessionB?.runtime,
			});
		});
	});

	// ── Phase 3: Permissions ──────────────────────────────────────────────────

	describe("Phase 3: Permissions", () => {
		const timer = createPhaseTimer("Phase 3: Permissions");
		beforeAll(timer.start);
		afterAll(timer.stop);

		it(SCENARIOS.VERIFY_NO_GRANTS.name, { timeout: 30_000 }, async () => {
			const result = await runCli([
				"--json",
				"--data-dir",
				agentBDir,
				"permissions",
				"show",
				AGENT_A_NAME,
			]);

			expect(result.exitCode, `permissions show failed:\n${result.stderr}`).toBe(0);

			const parsed = JSON.parse(result.stdout) as { data: PermissionSnapshot };
			const data = parsed.data;

			expect(
				data.granted_by_peer.grants,
				"Agent B should have no grants from Agent A before granting",
			).toEqual([]);
		});

		it(SCENARIOS.GRANT_TRANSFER.name, { timeout: 60_000 }, async () => {
			const grantFilePath = await writeGrantFile(agentADir, "usdc-transfer-grant.json", [
				{
					grantId: GRANT_ID,
					scope: "transfer/request",
					constraints: {
						asset: "usdc",
						chain: CHAIN.caip2,
						maxAmount: "0.01",
					},
				},
			]);

			// Stop sessionA to release the transport lock before permissions grant
			await sessionA?.stop();
			sessionA = undefined;

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"permissions",
				"grant",
				AGENT_B_NAME,
				"--file",
				grantFilePath,
				"--note",
				"e2e USDC transfer grant",
			]);

			// Exit 0 = confirmed delivery, Exit 5 = transport timeout (message likely sent, verified by sync)
			expect(
				[0, 5].includes(result.exitCode),
				`permissions grant failed with unexpected exit code ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
			).toBe(true);

			// Restart sessionA after permissions grant
			sessionA = await createAgentSession({ dataDir: agentADir });
		});

		// SYNC_GRANT removed: waitForPermissions below already syncs + polls state.
		// A standalone waitForSync was unreliable because the runtime's XMTP
		// stream listener processes messages in real-time, making reconcile()
		// return processed=0.

		it(SCENARIOS.VERIFY_GRANT.name, { timeout: 60_000 }, async () => {
			const snapshot = await waitForPermissions(
				agentBDir,
				AGENT_A_NAME,
				(data) =>
					data.granted_by_peer.grants.some((g) => g.grantId === GRANT_ID && g.status === "active"),
				60_000,
				2_000,
				sessionB?.runtime,
			);

			const grant = snapshot.granted_by_peer.grants.find((g) => g.grantId === GRANT_ID);
			expect(grant, `Grant "${GRANT_ID}" should be visible to Agent B`).toBeDefined();
			expect(grant?.status, `Grant "${GRANT_ID}" should be active`).toBe("active");
		});
	});

	// ── Phase 4: Messaging ────────────────────────────────────────────────────

	describe("Phase 4: Messaging", () => {
		const timer = createPhaseTimer("Phase 4: Messaging");
		beforeAll(timer.start);
		afterAll(timer.stop);

		it(SCENARIOS.SEND_MESSAGE_A_TO_B.name, { timeout: 60_000 }, async () => {
			// Stop sessionA to release the transport lock before message send
			await sessionA?.stop();
			sessionA = undefined;

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"ping from agent A",
				"--scope",
				"general-chat",
			]);

			// Exit 0 = confirmed delivery, Exit 5 = transport timeout (message likely sent, verified by sync)
			expect(
				[0, 5].includes(result.exitCode),
				`message send (A→B) failed with unexpected exit code ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
			).toBe(true);

			// Restart sessionA after message send
			sessionA = await createAgentSession({ dataDir: agentADir });
		});

		it(SCENARIOS.SYNC_MESSAGE_B.name, { timeout: 60_000 }, async () => {
			await waitForConversationMessage({
				dataDir: agentBDir,
				peerName: AGENT_A_NAME,
				contentIncludes: "ping from agent A",
				direction: "incoming",
				description: "Agent B receiving message from Agent A",
				timeoutMs: 60_000,
				runtime: sessionB?.runtime,
			});
		});

		it(SCENARIOS.SEND_MESSAGE_B_TO_A.name, { timeout: 60_000 }, async () => {
			// Stop sessionB to release the transport lock before message send
			await sessionB?.stop();
			sessionB = undefined;

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"message",
				"send",
				AGENT_A_NAME,
				"pong from agent B",
				"--scope",
				"general-chat",
			]);

			// Exit 0 = confirmed delivery, Exit 5 = transport timeout (message likely sent, verified by sync)
			expect(
				[0, 5].includes(result.exitCode),
				`message send (B→A) failed with unexpected exit code ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
			).toBe(true);

			// Restart sessionB after message send
			sessionB = await createAgentSession({ dataDir: agentBDir });
		});

		it(SCENARIOS.SYNC_MESSAGE_A.name, { timeout: 60_000 }, async () => {
			await waitForConversationMessage({
				dataDir: agentADir,
				peerName: AGENT_B_NAME,
				contentIncludes: "pong from agent B",
				direction: "incoming",
				description: "Agent A receiving message from Agent B",
				timeoutMs: 60_000,
				runtime: sessionA?.runtime,
			});
		});

		it(SCENARIOS.VERIFY_CONVERSATIONS.name, { timeout: 30_000 }, async () => {
			const aResult = await runCli([
				"--json",
				"--data-dir",
				agentADir,
				"conversations",
				"list",
				"--with",
				AGENT_B_NAME,
			]);
			expect(aResult.exitCode, `Agent A conversations list failed:\n${aResult.stderr}`).toBe(0);

			const aConvos = (
				JSON.parse(aResult.stdout) as {
					data: { conversations: Array<{ id: string; messages: number }> };
				}
			).data.conversations;
			// If message send timed out (exit 5), conversation is still logged locally
			expect(
				aConvos.length,
				"Agent A should have at least one conversation with Agent B",
			).toBeGreaterThan(0);
			expect(
				aConvos[0]!.messages,
				"Agent A conversation should contain at least one message",
			).toBeGreaterThan(0);

			const bResult = await runCli([
				"--json",
				"--data-dir",
				agentBDir,
				"conversations",
				"list",
				"--with",
				AGENT_A_NAME,
			]);
			expect(bResult.exitCode, `Agent B conversations list failed:\n${bResult.stderr}`).toBe(0);

			const bConvos = (
				JSON.parse(bResult.stdout) as {
					data: { conversations: Array<{ id: string; messages: number }> };
				}
			).data.conversations;
			// If message send timed out (exit 5), conversation is still logged locally
			expect(
				bConvos.length,
				"Agent B should have at least one conversation with Agent A",
			).toBeGreaterThan(0);
			expect(
				bConvos[0]!.messages,
				"Agent B conversation should contain at least one message",
			).toBeGreaterThan(0);
		});
	});

	// ── Phase 5: Transfers ────────────────────────────────────────────────────

	describe("Phase 5: Transfers", () => {
		const timer = createPhaseTimer("Phase 5: Transfers");
		beforeAll(timer.start);
		afterAll(timer.stop);

		it(SCENARIOS.RECORD_BALANCE_BEFORE.name, { timeout: 15_000 }, async () => {
			balanceBeforeTransfer = await getUsdcBalance(agentBAddress, CHAIN_KEY);
		});

		it(SCENARIOS.REQUEST_FUNDS_APPROVED.name, { timeout: 60_000 }, async () => {
			// Stop sessionB to release the transport lock before request-funds
			await sessionB?.stop();
			sessionB = undefined;

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"message",
				"request-funds",
				AGENT_A_NAME,
				"--asset",
				"usdc",
				"--amount",
				TRANSFER_AMOUNT,
				"--chain",
				CHAIN.alias,
				"--note",
				"e2e approved transfer request",
			]);

			// Exit 0 = confirmed delivery, Exit 5 = transport timeout (message likely sent, verified by sync)
			expect(
				[0, 5].includes(result.exitCode),
				`request-funds failed with unexpected exit code ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
			).toBe(true);

			// Restart sessionB after request-funds
			sessionB = await createAgentSession({ dataDir: agentBDir });
		});

		it(SCENARIOS.SYNC_TRANSFER_RESULT_B.name, { timeout: 60_000 }, async () => {
			// Agent A's listener auto-approves and executes the transfer.
			// Agent B must receive the action/result; tapd may process it before
			// a manual reconcile reports any new processed messages.
			await waitForConversationMessage({
				dataDir: agentBDir,
				peerName: AGENT_A_NAME,
				contentIncludes: `Transferred ${TRANSFER_AMOUNT} USDC`,
				direction: "incoming",
				description: "Agent B receiving transfer action/result",
				timeoutMs: 60_000,
				runtime: sessionB?.runtime,
			});
		});

		it(SCENARIOS.VERIFY_BALANCE_INCREASED.name, { timeout: 90_000 }, async () => {
			// AA-sponsored USDC transfer can take 30-60s to confirm on-chain
			balanceAfterTransfer = await waitForBalanceChange({
				address: agentBAddress,
				chainKey: CHAIN_KEY,
				previousBalance: balanceBeforeTransfer,
				description: "Agent B USDC balance increase after approved transfer",
				timeoutMs: 90_000,
			});

			const delta = balanceAfterTransfer - balanceBeforeTransfer;
			expect(
				delta >= TRANSFER_AMOUNT_UNITS,
				`Agent B balance should have increased by at least ${TRANSFER_AMOUNT} USDC (${TRANSFER_AMOUNT_UNITS} units). ` +
					`Before: ${formatUsdc(balanceBeforeTransfer, CHAIN_KEY)}, After: ${formatUsdc(balanceAfterTransfer, CHAIN_KEY)}, ` +
					`Delta: ${formatUsdc(delta, CHAIN_KEY)}`,
			).toBe(true);
		});

		it(SCENARIOS.REVOKE_GRANT.name, { timeout: 60_000 }, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"permissions",
				"revoke",
				AGENT_B_NAME,
				"--grant-id",
				GRANT_ID,
				"--note",
				"e2e revoke after transfer test",
			]);

			// Exit 0 = confirmed delivery, Exit 5 = transport timeout (message likely sent, verified by sync)
			expect(
				[0, 5].includes(result.exitCode),
				`permissions revoke failed with unexpected exit code ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
			).toBe(true);

			// Restart sessionA after listener stop + revoke
			sessionA = await createAgentSession({ dataDir: agentADir });
		});

		it(SCENARIOS.SYNC_REVOCATION.name, { timeout: 60_000 }, async () => {
			// Wait for Agent B to see the grant as revoked
			const snapshot = await waitForPermissions(
				agentBDir,
				AGENT_A_NAME,
				(data) =>
					data.granted_by_peer.grants.some((g) => g.grantId === GRANT_ID && g.status === "revoked"),
				60_000,
				2_000,
				sessionB?.runtime,
			);

			const grant = snapshot.granted_by_peer.grants.find((g) => g.grantId === GRANT_ID);
			expect(grant?.status, `Grant "${GRANT_ID}" should be revoked`).toBe("revoked");
		});

		it(SCENARIOS.REQUEST_FUNDS_REJECTED.name, { timeout: 60_000 }, async () => {
			// Stop sessionB to release the transport lock before request-funds
			await sessionB?.stop();
			sessionB = undefined;

			// Agent B sends another request — should be rejected because grant is revoked
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"message",
				"request-funds",
				AGENT_A_NAME,
				"--asset",
				"usdc",
				"--amount",
				TRANSFER_AMOUNT,
				"--chain",
				CHAIN.alias,
				"--note",
				"e2e rejected transfer request (no grant)",
			]);

			// The request itself may succeed (queued to XMTP) even if Agent A will reject it
			// Accept exit code 0 (queued), 3 (immediately rejected), or 5 (transport timeout — message likely sent)
			expect(
				[0, 3, 5].includes(result.exitCode),
				`request-funds (rejected) failed with unexpected exit code ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
			).toBe(true);

			// Restart sessionB after request-funds
			sessionB = await createAgentSession({ dataDir: agentBDir });
		});

		it(SCENARIOS.SYNC_REJECTION_A.name, { timeout: 60_000 }, async () => {
			// Agent A syncs: no matching grant, auto-rejects
			await waitForConversationMessage({
				dataDir: agentADir,
				peerName: AGENT_B_NAME,
				contentIncludes: `Transfer request rejected for ${TRANSFER_AMOUNT} USDC`,
				direction: "outgoing",
				description: "Agent A processing and auto-rejecting ungrantable transfer request",
				timeoutMs: 60_000,
				runtime: sessionA?.runtime,
			});
		});

		it(SCENARIOS.SYNC_REJECTION_RESULT_B.name, { timeout: 60_000 }, async () => {
			// Agent B syncs to pick up the rejection result
			await waitForConversationMessage({
				dataDir: agentBDir,
				peerName: AGENT_A_NAME,
				contentIncludes: `Transfer request rejected for ${TRANSFER_AMOUNT} USDC`,
				direction: "incoming",
				description: "Agent B receiving transfer rejection action/result",
				timeoutMs: 60_000,
				runtime: sessionB?.runtime,
			});
		});

		it(SCENARIOS.VERIFY_BALANCE_UNCHANGED.name, { timeout: 15_000 }, async () => {
			expect(
				balanceAfterTransfer,
				"balanceAfterTransfer must be set by the VERIFY_BALANCE_INCREASED test",
			).toBeDefined();

			const currentBalance = await getUsdcBalance(agentBAddress, CHAIN_KEY);

			expect(
				currentBalance,
				`Agent B balance should remain at ${formatUsdc(balanceAfterTransfer, CHAIN_KEY)} USDC after rejected transfer. ` +
					`Current: ${formatUsdc(currentBalance, CHAIN_KEY)} USDC`,
			).toBe(balanceAfterTransfer);
		});
	});
});
