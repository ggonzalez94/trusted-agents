import type { TrustedAgentsConfig } from "trusted-agents-core";
import * as core from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transferCommand } from "../src/commands/transfer.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as executionLib from "../src/lib/execution.js";
import * as promptLib from "../src/lib/prompt.js";
import * as walletLib from "../src/lib/wallet.js";

describe("tap transfer", () => {
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;

	function buildConfig(): TrustedAgentsConfig {
		return {
			agentId: 42,
			chain: "eip155:84532",
			privateKey: "0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11",
			dataDir: "/tmp/tap",
			chains: {
				"eip155:1": {
					name: "Ethereum Mainnet",
					caip2: "eip155:1",
					chainId: 1,
					rpcUrl: "https://example.test/mainnet",
					registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
				},
				"eip155:8453": {
					name: "Base",
					caip2: "eip155:8453",
					chainId: 8453,
					rpcUrl: "https://example.test/base",
					registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
				},
				"eip155:84532": {
					name: "Base Sepolia",
					caip2: "eip155:84532",
					chainId: 84532,
					rpcUrl: "https://example.test/base-sepolia",
					registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
				},
			},
			inviteExpirySeconds: 3600,
			resolveCacheTtlMs: 60000,
			resolveCacheMaxEntries: 100,
			xmtpEnv: "dev",
			xmtpDbEncryptionKey: undefined,
			execution: {
				mode: "eip7702",
				paymasterProvider: "circle",
			},
		};
	}

	beforeEach(() => {
		stdoutWrites = [];
		stderrWrites = [];
		process.exitCode = undefined;

		origStdoutWrite = process.stdout.write;
		origStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string) => {
			stdoutWrites.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => {
			stderrWrites.push(chunk);
			return true;
		}) as typeof process.stderr.write;

		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(buildConfig());
		vi.spyOn(executionLib, "getExecutionPreview").mockResolvedValue({
			requestedMode: "eip7702",
			mode: "eip7702",
			messagingAddress: "0x0000000000000000000000000000000000000001",
			executionAddress: "0x0000000000000000000000000000000000000002",
			fundingAddress: "0x0000000000000000000000000000000000000003",
			paymasterProvider: "circle",
			warnings: [],
		});
		vi.spyOn(promptLib, "promptYesNo").mockResolvedValue(true);
		vi.spyOn(core, "executeOnchainTransfer").mockResolvedValue({
			txHash: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed627f5f14abf84df9f6a0d908",
		});
		vi.spyOn(walletLib, "buildPublicClient").mockReturnValue({
			estimateGas: vi.fn().mockResolvedValue(21000n),
			estimateFeesPerGas: vi.fn().mockResolvedValue({
				gasPrice: 1000000000n,
				maxFeePerGas: 2000000000n,
				maxPriorityFeePerGas: 1000000000n,
			}),
		} as never);
	});

	afterEach(() => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("returns validation error for invalid recipient address", async () => {
		await transferCommand(
			{ to: "not-an-address", asset: "native", amount: "1", yes: true },
			{ json: true },
		);

		const output = JSON.parse(stdoutWrites.join("")) as {
			ok: boolean;
			error?: { code?: string; message?: string };
		};
		expect(output.ok).toBe(false);
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
			ok: boolean;
			error?: { code?: string; message?: string };
		};
		expect(output.ok).toBe(false);
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
			ok: boolean;
			error?: { code?: string; message?: string };
		};
		expect(output.ok).toBe(false);
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
			ok: boolean;
			error?: { code?: string; message?: string };
		};
		expect(output.ok).toBe(false);
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
			ok: boolean;
			error?: { code?: string; message?: string };
		};
		expect(output.ok).toBe(false);
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
			expect.objectContaining({
				asset: "usdc",
				amount: "5",
				chain: "eip155:8453",
				toAddress: "0x1111111111111111111111111111111111111111",
				type: "transfer/request",
			}),
		);

		const output = JSON.parse(stdoutWrites.join("")) as {
			ok: boolean;
			data?: Record<string, unknown>;
		};
		expect(output.ok).toBe(true);
		expect(output.data?.status).toBe("submitted");
		expect(output.data?.tx_hash).toBe(
			"0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed627f5f14abf84df9f6a0d908",
		);
		expect(output.data?.chain).toBe("eip155:8453");
	});

	it("passes the USDC contract address (not recipient) to gas estimation", async () => {
		const estimateGas = vi.fn().mockResolvedValue(65000n);
		vi.mocked(walletLib.buildPublicClient).mockReturnValue({
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
				chain: "base-sepolia",
				yes: true,
			},
			{ json: true },
		);

		expect(estimateGas).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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
			ok: boolean;
			data?: Record<string, unknown>;
		};
		expect(output.ok).toBe(true);
		expect(output.data?.status).toBe("cancelled");
		expect(output.data?.cancelled).toBe(true);
	});
});
