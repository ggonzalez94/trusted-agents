import type { TrustedAgentsConfig } from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { balanceCommand } from "../src/commands/balance.js";
import * as configLoader from "../src/lib/config-loader.js";
import * as executionLib from "../src/lib/execution.js";
import * as walletLib from "../src/lib/wallet.js";

describe("tap balance", () => {
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let origStdoutWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;
	const privateKey = "0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11" as const;
	const address = privateKeyToAccount(privateKey).address;

	function buildConfig(): TrustedAgentsConfig {
		return {
			agentId: -1,
			chain: "eip155:8453",
			privateKey,
			dataDir: "/tmp/tap",
			chains: {
				"eip155:8453": {
					name: "Base",
					caip2: "eip155:8453",
					chainId: 8453,
					rpcUrl: "https://example.test/base",
					registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
				},
				"eip155:167000": {
					name: "Taiko",
					caip2: "eip155:167000",
					chainId: 167000,
					rpcUrl: "https://example.test/taiko",
					registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
				},
			},
			inviteExpirySeconds: 3600,
			resolveCacheTtlMs: 60000,
			resolveCacheMaxEntries: 100,
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
			messagingAddress: address,
			executionAddress: address,
			fundingAddress: address,
			paymasterProvider: "candide",
			warnings: [],
		});
	});

	afterEach(() => {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("uses the configured chain by default and returns native plus USDC balances", async () => {
		const getBalance = vi.fn().mockResolvedValue(1234000000000000000n);
		const readContract = vi.fn().mockResolvedValue(9876543n);
		vi.spyOn(walletLib, "buildPublicClient").mockReturnValue({
			getBalance,
			readContract,
		} as never);

		await balanceCommand({ json: true });

		expect(getBalance).toHaveBeenCalledOnce();
		expect(readContract).toHaveBeenCalledWith(
			expect.objectContaining({
				address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
				functionName: "balanceOf",
			}),
		);

		const output = JSON.parse(stdoutWrites.join("")) as {
			ok: boolean;
			data?: Record<string, unknown>;
		};
		expect(output.ok).toBe(true);
		expect(output.data?.address).toBe(address);
		expect(output.data?.messaging_address).toBe(address);
		expect(output.data?.execution_address).toBe(address);
		expect(output.data?.chain).toBe("eip155:8453");
		expect(output.data?.execution_native_balance).toBe("1.234");
		expect(output.data?.execution_usdc_balance).toBe("9.876543");
	});

	it("accepts a natural-language chain alias", async () => {
		vi.spyOn(walletLib, "buildPublicClient").mockReturnValue({
			getBalance: vi.fn().mockResolvedValue(1n),
			readContract: vi.fn().mockResolvedValue(2n),
		} as never);

		await balanceCommand({ json: true }, "base");

		expect(walletLib.buildPublicClient).toHaveBeenCalledWith(
			expect.objectContaining({ caip2: "eip155:8453" }),
		);
		const output = JSON.parse(stdoutWrites.join("")) as {
			data?: Record<string, unknown>;
		};
		expect(output.data?.chain).toBe("eip155:8453");
	});

	it("accepts a CAIP-2 chain identifier", async () => {
		vi.spyOn(walletLib, "buildPublicClient").mockReturnValue({
			getBalance: vi.fn().mockResolvedValue(1n),
			readContract: vi.fn().mockResolvedValue(2n),
		} as never);

		await balanceCommand({ json: true }, "eip155:8453");

		expect(walletLib.buildPublicClient).toHaveBeenCalledWith(
			expect.objectContaining({ caip2: "eip155:8453" }),
		);
		const output = JSON.parse(stdoutWrites.join("")) as {
			data?: Record<string, unknown>;
		};
		expect(output.data?.chain).toBe("eip155:8453");
	});

	it("returns native plus USDC balances on Taiko", async () => {
		const readContract = vi.fn().mockResolvedValue(7654321n);
		vi.spyOn(walletLib, "buildPublicClient").mockReturnValue({
			getBalance: vi.fn().mockResolvedValue(5n),
			readContract,
		} as never);

		await balanceCommand({ json: true }, "taiko");

		expect(readContract).toHaveBeenCalledWith(
			expect.objectContaining({
				address: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
				functionName: "balanceOf",
			}),
		);
		const output = JSON.parse(stdoutWrites.join("")) as {
			data?: Record<string, unknown>;
		};
		expect(output.data?.chain).toBe("eip155:167000");
		expect(output.data?.usdc_supported).toBe(true);
		expect(output.data?.execution_usdc_balance).toBe("7.654321");
	});

	it("returns a validation error for an unknown chain", async () => {
		const buildPublicClientSpy = vi.spyOn(walletLib, "buildPublicClient");

		await balanceCommand({ json: true }, "not-a-chain");

		expect(buildPublicClientSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites.join("")) as {
			ok: boolean;
			error?: Record<string, unknown>;
		};
		expect(output.ok).toBe(false);
		expect(output.error?.code).toBe("VALIDATION_ERROR");
		expect(output.error?.message).toContain("Unknown chain");
	});
});
