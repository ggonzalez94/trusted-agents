/**
 * Tests for `tap transfer` after the Phase 3 refactor.
 *
 * The on-chain broadcast now happens inside tapd, so the CLI test is just:
 * - validate flags
 * - prompt for confirmation (or skip with --yes)
 * - POST /api/transfers with the expected body
 * - format the response with the legacy success shape
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transferCommand } from "../src/commands/transfer.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as promptLib from "../src/lib/prompt.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { TEST_BASE_CHAIN, buildTestConfig } from "./helpers/config-fixtures.js";
import { type FakeTapdHandle, startFakeTapd } from "./helpers/fake-tapd-socket.ts";

describe("tap transfer (tapd client refactor)", () => {
	const { stdout: stdoutWrites } = useCapturedOutput();
	let fake: FakeTapdHandle | null;
	let testConfig: ReturnType<typeof buildTestConfig>;

	beforeEach(async () => {
		fake = null;
		testConfig = buildTestConfig({
			agentId: 42,
			chains: {
				"eip155:1": {
					name: "Ethereum Mainnet",
					caip2: "eip155:1",
					chainId: 1,
					rpcUrl: "https://example.test/mainnet",
					registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
				},
				"eip155:8453": TEST_BASE_CHAIN,
			},
		});
		// Tests that don't call tapd (validation, dry-run, cancel) just need
		// loadConfig wired to *some* dataDir; tests that do call tapd use
		// `withFakeTapd` to spin up a server and re-mock loadConfig with the
		// fake's dataDir.
		vi.spyOn(configLoader, "loadConfig").mockResolvedValue({
			...testConfig,
			dataDir: "/tmp/tap-transfer-validation-stub",
		});
		vi.spyOn(promptLib, "promptYesNo").mockResolvedValue(true);
		process.exitCode = undefined;
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await fake?.stop();
		process.exitCode = undefined;
	});

	/** Spin up a fake tapd socket and wire loadConfig to its dataDir. */
	async function withFakeTapd(
		routes: Parameters<typeof startFakeTapd>[0]["routes"],
	): Promise<void> {
		fake = await startFakeTapd({ routes });
		vi.spyOn(configLoader, "loadConfig").mockResolvedValue({
			...testConfig,
			dataDir: fake.dataDir,
		});
	}

	it.each([
		[
			"invalid recipient address",
			{ to: "not-an-address", asset: "native", amount: "1", yes: true },
			"Invalid recipient address",
		],
		[
			"non-positive amount",
			{ to: "0x1111111111111111111111111111111111111111", asset: "native", amount: "0", yes: true },
			"Amount must be a positive number",
		],
		[
			"unsupported asset",
			{ to: "0x1111111111111111111111111111111111111111", asset: "dai", amount: "1", yes: true },
			"Unsupported asset",
		],
		[
			"unknown chain",
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "native",
				amount: "1",
				chain: "not-a-chain",
				yes: true,
			},
			"Unknown chain",
		],
	])("returns validation error for %s", async (_, args, expectedMessage) => {
		await transferCommand(args, { json: true });
		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: { code?: string; message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
		expect(output.error?.message).toContain(expectedMessage);
	});

	it("POSTs to /api/transfers and surfaces the legacy submitted payload", async () => {
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/transfers",
				handler: () => ({
					txHash: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed627f5f14abf84df9f6a0d908",
				}),
			},
		]);

		await transferCommand(
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "usdc",
				amount: "5",
				chain: "base",
				yes: true,
			},
			{ json: true },
		);

		expect(promptLib.promptYesNo).not.toHaveBeenCalled();
		expect(fake?.calls).toHaveLength(1);
		expect(fake?.calls[0]?.body).toEqual({
			asset: "usdc",
			amount: "5",
			chain: "eip155:8453",
			toAddress: "0x1111111111111111111111111111111111111111",
		});

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: Record<string, unknown>;
		};
		expect(output.status).toBe("ok");
		expect(output.data?.status).toBe("submitted");
		expect(output.data?.tx_hash).toBe(
			"0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed627f5f14abf84df9f6a0d908",
		);
		expect(output.data?.chain).toBe("eip155:8453");
	});

	it("returns a preview and skips execution in dry-run mode", async () => {
		await transferCommand(
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "usdc",
				amount: "5",
				chain: "base",
				dryRun: true,
			},
			{ output: "json" },
		);

		expect(promptLib.promptYesNo).not.toHaveBeenCalled();
		expect(fake).toBeNull();
		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: Record<string, unknown>;
		};
		expect(output.status).toBe("ok");
		expect(output.data?.status).toBe("preview");
		expect(output.data?.dry_run).toBe(true);
		expect(output.data?.scope).toBe("transfer/execute");
	});

	it("cancels cleanly when confirmation is declined", async () => {
		vi.mocked(promptLib.promptYesNo).mockResolvedValueOnce(false);

		await transferCommand(
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "native",
				amount: "1",
			},
			{ json: true },
		);

		expect(fake).toBeNull();
		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: Record<string, unknown>;
		};
		expect(output.status).toBe("ok");
		expect(output.data?.status).toBe("cancelled");
		expect(output.data?.cancelled).toBe(true);
	});
});
