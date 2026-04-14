/**
 * Tests for `tap transfer` after the Phase 3 refactor.
 *
 * The on-chain broadcast now happens inside tapd, so the CLI test is just:
 * - validate flags
 * - prompt for confirmation (or skip with --yes)
 * - POST /api/transfers with the expected body
 * - format the response with the legacy success shape
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transferCommand } from "../src/commands/transfer.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as promptLib from "../src/lib/prompt.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { TEST_BASE_CHAIN, buildTestConfig } from "./helpers/config-fixtures.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("tap transfer (tapd client refactor)", () => {
	const { stdout: stdoutWrites } = useCapturedOutput();
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tap-transfer-"));
		await writeFile(join(dataDir, ".tapd.port"), "4321", "utf-8");
		await writeFile(join(dataDir, ".tapd-token"), "token-xyz", "utf-8");

		const config = buildTestConfig({
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
		// useCapturedOutput shares stdout across tests and uses captureOutput,
		// so we override loadConfig to return our test config with the temp dataDir.
		vi.spyOn(configLoader, "loadConfig").mockResolvedValue({ ...config, dataDir });
		vi.spyOn(promptLib, "promptYesNo").mockResolvedValue(true);
		process.exitCode = undefined;
	});

	afterEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
		process.exitCode = undefined;
	});

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
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				txHash: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed627f5f14abf84df9f6a0d908",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

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
		expect(fetchMock).toHaveBeenCalledOnce();
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({
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
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

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
		expect(fetchMock).not.toHaveBeenCalled();
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
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await transferCommand(
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "native",
				amount: "1",
			},
			{ json: true },
		);

		expect(fetchMock).not.toHaveBeenCalled();
		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: Record<string, unknown>;
		};
		expect(output.status).toBe("ok");
		expect(output.data?.status).toBe("cancelled");
		expect(output.data?.cancelled).toBe(true);
	});
});
