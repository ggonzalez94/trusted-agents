import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnits } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/run-cli.js";
import {
	CHAIN_CONFIGS,
	type PermissionSnapshot,
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

// ── Shared state (mutated across test phases) ─────────────────────────────────

let tempRoot: string;
let agentADir: string;
let agentBDir: string;
let agentAAddress: `0x${string}`;
let agentBAddress: `0x${string}`;
let inviteUrl: string;
let balanceBeforeTransfer: bigint;
let balanceAfterTransfer: bigint;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("TAP live E2E — real XMTP + OWS + on-chain", { timeout: 600_000 }, () => {
	beforeAll(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-e2e-live-"));
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

	// ── Phase 1: Onboarding ───────────────────────────────────────────────────

	describe("Phase 1: Onboarding", () => {
		it(SCENARIOS.INIT_AGENT_A.name, { timeout: 120_000 }, async () => {
			const walletA = requireEnv("E2E_AGENT_A_OWS_WALLET");
			const apikeyA = requireEnv("E2E_AGENT_A_OWS_API_KEY");

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"init",
				"--chain",
				CHAIN.alias,
				"--wallet",
				walletA,
				"--passphrase",
				apikeyA,
				"--non-interactive",
			]);

			expect(result.exitCode, `Agent A init failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.INIT_AGENT_B.name, { timeout: 120_000 }, async () => {
			const walletB = requireEnv("E2E_AGENT_B_OWS_WALLET");
			const apikeyB = requireEnv("E2E_AGENT_B_OWS_API_KEY");

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"init",
				"--chain",
				CHAIN.alias,
				"--wallet",
				walletB,
				"--passphrase",
				apikeyB,
				"--non-interactive",
			]);

			expect(result.exitCode, `Agent B init failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.BALANCE_CHECK_A.name, { timeout: 15_000 }, async () => {
			agentAAddress = await readAgentAddress(agentADir);
			const balance = await getUsdcBalance(agentAAddress, CHAIN_KEY);

			expect(
				balance >= MIN_BALANCE_UNITS,
				`Agent A (${agentAAddress}) has insufficient USDC balance on ${CHAIN.alias}. Found: ${formatUsdc(balance, CHAIN_KEY)} USDC. Required: at least 0.50 USDC. Please fund this address before running the live E2E test.`,
			).toBe(true);
		});

		it(SCENARIOS.BALANCE_CHECK_B.name, { timeout: 15_000 }, async () => {
			agentBAddress = await readAgentAddress(agentBDir);
			const balance = await getUsdcBalance(agentBAddress, CHAIN_KEY);

			expect(
				balance >= MIN_BALANCE_UNITS,
				`Agent B (${agentBAddress}) has insufficient USDC balance on ${CHAIN.alias}. Found: ${formatUsdc(balance, CHAIN_KEY)} USDC. Required: at least 0.50 USDC. Please fund this address before running the live E2E test.`,
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
			const result = await runCli(["--json", "--data-dir", agentADir, "identity", "resolve-self"]);

			expect(result.exitCode, `Agent A resolve-self failed:\n${result.stderr}`).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { name: string; agentAddress: string };

			expect(data.name, "Agent A resolved name should match registered name").toBe(AGENT_A_NAME);
		});

		it(SCENARIOS.RESOLVE_AGENT_B.name, { timeout: 30_000 }, async () => {
			const result = await runCli(["--json", "--data-dir", agentBDir, "identity", "resolve-self"]);

			expect(result.exitCode, `Agent B resolve-self failed:\n${result.stderr}`).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { name: string; agentAddress: string };

			expect(data.name, "Agent B resolved name should match registered name").toBe(AGENT_B_NAME);
		});
	});

	// ── Phase 2: Connection ───────────────────────────────────────────────────

	describe("Phase 2: Connection", () => {
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

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"connect",
				inviteUrl,
				"--yes",
			]);

			expect(result.exitCode, `Agent B connect failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.SYNC_CONNECTION_A.name, { timeout: 60_000 }, async () => {
			await waitForSync({
				dataDir: agentADir,
				description: "Agent A processing inbound connection/request",
				timeoutMs: 60_000,
			});
		});

		it(SCENARIOS.SYNC_CONNECTION_B.name, { timeout: 60_000 }, async () => {
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receiving connection/result",
				timeoutMs: 60_000,
			});
		});

		it(SCENARIOS.VERIFY_CONTACTS_A.name, { timeout: 15_000 }, async () => {
			await assertContactActive(agentADir, AGENT_B_NAME);
		});

		it(SCENARIOS.VERIFY_CONTACTS_B.name, { timeout: 15_000 }, async () => {
			await assertContactActive(agentBDir, AGENT_A_NAME);
		});
	});

	// ── Phase 3: Permissions ──────────────────────────────────────────────────

	describe("Phase 3: Permissions", () => {
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

			expect(result.exitCode, `Agent A permissions grant failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.SYNC_GRANT.name, { timeout: 60_000 }, async () => {
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receiving permissions/update grant",
				timeoutMs: 60_000,
			});
		});

		it(SCENARIOS.VERIFY_GRANT.name, { timeout: 60_000 }, async () => {
			const snapshot = await waitForPermissions(
				agentBDir,
				AGENT_A_NAME,
				(data) =>
					data.granted_by_peer.grants.some((g) => g.grantId === GRANT_ID && g.status === "active"),
				60_000,
			);

			const grant = snapshot.granted_by_peer.grants.find((g) => g.grantId === GRANT_ID);
			expect(grant, `Grant "${GRANT_ID}" should be visible to Agent B`).toBeDefined();
			expect(grant?.status, `Grant "${GRANT_ID}" should be active`).toBe("active");
		});
	});

	// ── Phase 4: Messaging ────────────────────────────────────────────────────

	describe("Phase 4: Messaging", () => {
		it(SCENARIOS.SEND_MESSAGE_A_TO_B.name, { timeout: 60_000 }, async () => {
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

			expect(result.exitCode, `Agent A message send failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.SYNC_MESSAGE_B.name, { timeout: 60_000 }, async () => {
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receiving message from Agent A",
				timeoutMs: 60_000,
			});
		});

		it(SCENARIOS.SEND_MESSAGE_B_TO_A.name, { timeout: 60_000 }, async () => {
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

			expect(result.exitCode, `Agent B message send failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.SYNC_MESSAGE_A.name, { timeout: 60_000 }, async () => {
			await waitForSync({
				dataDir: agentADir,
				description: "Agent A receiving message from Agent B",
				timeoutMs: 60_000,
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
		it(SCENARIOS.RECORD_BALANCE_BEFORE.name, { timeout: 15_000 }, async () => {
			balanceBeforeTransfer = await getUsdcBalance(agentBAddress, CHAIN_KEY);
		});

		it(SCENARIOS.REQUEST_FUNDS_APPROVED.name, { timeout: 60_000 }, async () => {
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

			expect(result.exitCode, `Agent B request-funds failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.SYNC_TRANSFER_A.name, { timeout: 60_000 }, async () => {
			// Agent A syncs: decideTransfer auto-approves because grant matches (no approveTransfer hook in CLI)
			await waitForSync({
				dataDir: agentADir,
				description: "Agent A processing transfer request and auto-approving via grant",
				timeoutMs: 60_000,
			});
		});

		it(SCENARIOS.SYNC_TRANSFER_RESULT_B.name, { timeout: 60_000 }, async () => {
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receiving transfer action/result",
				timeoutMs: 60_000,
			});
		});

		it(SCENARIOS.VERIFY_BALANCE_INCREASED.name, { timeout: 30_000 }, async () => {
			balanceAfterTransfer = await waitForBalanceChange({
				address: agentBAddress,
				chainKey: CHAIN_KEY,
				previousBalance: balanceBeforeTransfer,
				description: "Agent B USDC balance increase after approved transfer",
				timeoutMs: 30_000,
			});

			const delta = balanceAfterTransfer - balanceBeforeTransfer;
			expect(
				delta,
				`Agent B balance should have increased by ${TRANSFER_AMOUNT} USDC (${TRANSFER_AMOUNT_UNITS} units). ` +
					`Before: ${formatUsdc(balanceBeforeTransfer, CHAIN_KEY)}, After: ${formatUsdc(balanceAfterTransfer, CHAIN_KEY)}`,
			).toBe(TRANSFER_AMOUNT_UNITS);
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

			expect(result.exitCode, `Agent A permissions revoke failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.SYNC_REVOCATION.name, { timeout: 60_000 }, async () => {
			// Wait for Agent B to see the grant as revoked
			const snapshot = await waitForPermissions(
				agentBDir,
				AGENT_A_NAME,
				(data) =>
					data.granted_by_peer.grants.some((g) => g.grantId === GRANT_ID && g.status === "revoked"),
				60_000,
			);

			const grant = snapshot.granted_by_peer.grants.find((g) => g.grantId === GRANT_ID);
			expect(grant?.status, `Grant "${GRANT_ID}" should be revoked`).toBe("revoked");
		});

		it(SCENARIOS.REQUEST_FUNDS_REJECTED.name, { timeout: 60_000 }, async () => {
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
			// Accept exit code 0 (queued) or 3 (immediately rejected)
			expect(
				[0, 3].includes(result.exitCode),
				`Expected exit code 0 or 3, got ${result.exitCode}:\n${result.stderr}`,
			).toBe(true);
		});

		it(SCENARIOS.SYNC_REJECTION_A.name, { timeout: 60_000 }, async () => {
			// Agent A syncs: no matching grant, auto-rejects
			await waitForSync({
				dataDir: agentADir,
				description: "Agent A processing and auto-rejecting ungrantable transfer request",
				timeoutMs: 60_000,
			});
		});

		it(SCENARIOS.SYNC_REJECTION_RESULT_B.name, { timeout: 60_000 }, async () => {
			// Agent B syncs to pick up the rejection result
			await waitForSync({
				dataDir: agentBDir,
				description: "Agent B receiving transfer rejection action/result",
				timeoutMs: 60_000,
			});
		});

		it(SCENARIOS.VERIFY_BALANCE_UNCHANGED.name, { timeout: 15_000 }, async () => {
			const currentBalance = await getUsdcBalance(agentBAddress, CHAIN_KEY);

			expect(
				currentBalance,
				`Agent B balance should remain unchanged at ${formatUsdc(balanceAfterTransfer, CHAIN_KEY)} USDC after rejected transfer. ` +
					`Current: ${formatUsdc(currentBalance, CHAIN_KEY)} USDC`,
			).toBe(balanceAfterTransfer);
		});
	});
});
