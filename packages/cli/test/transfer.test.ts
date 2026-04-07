import * as core from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transferCommand } from "../src/commands/transfer.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as promptLib from "../src/lib/prompt.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import { TEST_BASE_CHAIN, buildTestConfig } from "./helpers/config-fixtures.js";

const { mockOwsProvider, mockExecuteOnchainTransfer } = vi.hoisted(() => ({
	mockOwsProvider: vi.fn().mockImplementation(() => ({
		getAddress: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000001"),
		signMessage: vi.fn(),
		signTypedData: vi.fn(),
		signTransaction: vi.fn(),
		signAuthorization: vi.fn(),
	})),
	mockExecuteOnchainTransfer: vi.fn().mockResolvedValue({
		txHash: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed627f5f14abf84df9f6a0d908",
	}),
}));

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: mockOwsProvider,
		executeOnchainTransfer: mockExecuteOnchainTransfer,
	};
});

describe("tap transfer", () => {
	const { stdout: stdoutWrites } = useCapturedOutput();

	function buildConfig() {
		return buildTestConfig({
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
	}

	beforeEach(() => {
		process.exitCode = undefined;

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(buildConfig());
		vi.spyOn(core, "getExecutionPreview").mockResolvedValue({
			requestedMode: "eip7702",
			mode: "eip7702",
			messagingAddress: "0x0000000000000000000000000000000000000001",
			executionAddress: "0x0000000000000000000000000000000000000002",
			fundingAddress: "0x0000000000000000000000000000000000000003",
			paymasterProvider: "circle",
			warnings: [],
		});
		vi.spyOn(promptLib, "promptYesNo").mockResolvedValue(true);
		vi.spyOn(core, "buildChainPublicClient").mockReturnValue({
			estimateGas: vi.fn().mockResolvedValue(21000n),
			estimateFeesPerGas: vi.fn().mockResolvedValue({
				gasPrice: 1000000000n,
				maxFeePerGas: 2000000000n,
				maxPriorityFeePerGas: 1000000000n,
			}),
		} as never);
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.clearAllMocks();
	});

	it("returns validation error for invalid recipient address", async () => {
		await transferCommand(
			{ to: "not-an-address", asset: "native", amount: "1", yes: true },
			{ json: true },
		);

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: { code?: string; message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
		expect(output.error?.message).toContain("Invalid recipient address");
		expect(core.executeOnchainTransfer).not.toHaveBeenCalled();
	});

	it("returns validation error for non-positive amount", async () => {
		await transferCommand(
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "native",
				amount: "0",
				yes: true,
			},
			{ json: true },
		);

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: { code?: string; message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
		expect(output.error?.message).toContain("Amount must be a positive number");
	});

	it("returns validation error for unsupported asset", async () => {
		await transferCommand(
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "dai",
				amount: "1",
				yes: true,
			},
			{ json: true },
		);

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: { code?: string; message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
		expect(output.error?.message).toContain("Unsupported asset");
	});

	it("returns validation error for unknown chain", async () => {
		await transferCommand(
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "native",
				amount: "1",
				chain: "not-a-chain",
				yes: true,
			},
			{ json: true },
		);

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: { code?: string; message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
		expect(output.error?.message).toContain("Unknown chain");
		expect(process.exitCode).toBe(2);
	});

	it("returns validation error when usdc is unsupported on the selected chain", async () => {
		await transferCommand(
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "usdc",
				amount: "1",
				chain: "eip155:1",
				yes: true,
			},
			{ json: true },
		);

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: { code?: string; message?: string };
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
		expect(output.error?.message).toContain("USDC is not supported");
	});

	it("executes a transfer using resolved chain aliases", async () => {
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
		expect(core.executeOnchainTransfer).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				asset: "usdc",
				amount: "5",
				chain: "eip155:8453",
				toAddress: "0x1111111111111111111111111111111111111111",
				type: "transfer/request",
			}),
		);

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
		expect(core.executeOnchainTransfer).not.toHaveBeenCalled();

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: Record<string, unknown>;
		};
		expect(output.status).toBe("ok");
		expect(output.data?.status).toBe("preview");
		expect(output.data?.dry_run).toBe(true);
		expect(output.data?.scope).toBe("transfer/execute");
		expect(output.data?.execution_mode).toBe("eip7702");
	});

	it("passes the USDC contract address (not recipient) to gas estimation", async () => {
		const estimateGas = vi.fn().mockResolvedValue(65000n);
		vi.mocked(core.buildChainPublicClient).mockReturnValue({
			estimateGas,
			estimateFeesPerGas: vi.fn().mockResolvedValue({
				gasPrice: 1000000000n,
				maxFeePerGas: 2000000000n,
				maxPriorityFeePerGas: 1000000000n,
			}),
		} as never);

		await transferCommand(
			{
				to: "0x1111111111111111111111111111111111111111",
				asset: "usdc",
				amount: "10",
				chain: "base",
				yes: true,
			},
			{ json: true },
		);

		expect(estimateGas).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			}),
		);
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

		expect(core.executeOnchainTransfer).not.toHaveBeenCalled();
		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: Record<string, unknown>;
		};
		expect(output.status).toBe("ok");
		expect(output.data?.status).toBe("cancelled");
		expect(output.data?.cancelled).toBe(true);
	});
});
