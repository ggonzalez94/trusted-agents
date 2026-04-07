import type { Address, Hex } from "viem";
import { encodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it, vi } from "vitest";
import { assertServoTokenSpendFitsBalance } from "../../../src/runtime/execution/servo.js";
import type {
	Eip4337ExecutionContext,
	ServoQuoteResponse,
} from "../../../src/runtime/execution/types.js";

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EXECUTION_ADDRESS: Address = "0x1000000000000000000000000000000000000001";

const BASE_CHAIN_CONFIG = {
	caip2: "eip155:8453",
	chainId: 8453,
	name: "Base",
	rpcUrl: "https://mainnet.base.org",
	registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
};

function buildStubQuote(overrides: Partial<ServoQuoteResponse> = {}): ServoQuoteResponse {
	return {
		paymaster: "0x2000000000000000000000000000000000000002" as Address,
		paymasterData: "0x" as Hex,
		paymasterAndData: "0x" as Hex,
		callGasLimit: "0x10000" as Hex,
		verificationGasLimit: "0x10000" as Hex,
		preVerificationGas: "0x10000" as Hex,
		paymasterVerificationGasLimit: "0x10000" as Hex,
		paymasterPostOpGasLimit: "0x10000" as Hex,
		tokenAddress: USDC_BASE,
		maxTokenCostMicros: "50000", // 0.05 USDC
		validUntil: Math.floor(Date.now() / 1000) + 300,
		...overrides,
	};
}

function buildContext(balanceRaw: bigint): Eip4337ExecutionContext {
	const readContract = vi.fn().mockResolvedValue(balanceRaw);
	return {
		executionAddress: EXECUTION_ADDRESS,
		publicClient: { readContract } as unknown as Eip4337ExecutionContext["publicClient"],
	} as unknown as Eip4337ExecutionContext;
}

function buildUsdcTransferCall(amount: bigint): { to: Address; data: Hex } {
	return {
		to: USDC_BASE,
		data: encodeFunctionData({
			abi: erc20Abi,
			functionName: "transfer",
			args: [EXECUTION_ADDRESS, amount],
		}),
	};
}

describe("assertServoTokenSpendFitsBalance", () => {
	it("passes when balance covers paymaster fee for a non-transfer call", async () => {
		const context = buildContext(100_000n); // 0.10 USDC
		const quote = buildStubQuote({ maxTokenCostMicros: "50000" }); // 0.05 USDC fee
		const calls = [{ to: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address }];

		await expect(
			assertServoTokenSpendFitsBalance(context, BASE_CHAIN_CONFIG, calls, quote),
		).resolves.toBeUndefined();
	});

	it("throws when balance cannot cover paymaster fee for a non-transfer call", async () => {
		const context = buildContext(0n); // empty
		const quote = buildStubQuote({ maxTokenCostMicros: "50000" }); // 0.05 USDC fee
		const calls = [{ to: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address }];

		await expect(
			assertServoTokenSpendFitsBalance(context, BASE_CHAIN_CONFIG, calls, quote),
		).rejects.toThrow(/Insufficient USDC to pay the Servo paymaster fee/);
	});

	it("includes the execution address and chain in the paymaster-fee error", async () => {
		const context = buildContext(10_000n); // 0.01 USDC
		const quote = buildStubQuote({ maxTokenCostMicros: "50000" }); // 0.05 USDC fee
		const calls = [{ to: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address }];

		await expect(
			assertServoTokenSpendFitsBalance(context, BASE_CHAIN_CONFIG, calls, quote),
		).rejects.toThrow(EXECUTION_ADDRESS);
	});

	it("throws the transfer-specific error when an outgoing USDC transfer exceeds balance", async () => {
		const context = buildContext(100_000n); // 0.10 USDC
		const quote = buildStubQuote({ maxTokenCostMicros: "50000" }); // 0.05 USDC fee
		const calls = [buildUsdcTransferCall(200_000n)]; // 0.20 USDC transfer

		await expect(
			assertServoTokenSpendFitsBalance(context, BASE_CHAIN_CONFIG, calls, quote),
		).rejects.toThrow(/Insufficient USDC balance for transfer/);
	});

	it("passes when balance covers both transfer and paymaster fee", async () => {
		const context = buildContext(300_000n); // 0.30 USDC
		const quote = buildStubQuote({ maxTokenCostMicros: "50000" }); // 0.05 USDC fee
		const calls = [buildUsdcTransferCall(200_000n)]; // 0.20 USDC transfer

		await expect(
			assertServoTokenSpendFitsBalance(context, BASE_CHAIN_CONFIG, calls, quote),
		).resolves.toBeUndefined();
	});

	it("skips the check entirely when paymaster fee is zero and no transfers", async () => {
		const context = buildContext(0n);
		const quote = buildStubQuote({ maxTokenCostMicros: "0" });
		const calls = [{ to: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address }];

		await expect(
			assertServoTokenSpendFitsBalance(context, BASE_CHAIN_CONFIG, calls, quote),
		).resolves.toBeUndefined();
		// Should not even call readContract when totalNeeded is 0
		expect(context.publicClient.readContract).not.toHaveBeenCalled();
	});
});
