import * as core from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { balanceCommand } from "../src/commands/balance.js";
import * as configLoader from "../src/lib/config-loader.js";
import { useCapturedOutput } from "./helpers/capture-output.js";
import {
	TEST_BASE_CHAIN,
	TEST_TAIKO_CHAIN,
	buildMockExecutionPreview,
	buildTestConfig,
} from "./helpers/config-fixtures.js";

const { ADDRESS, mockOwsProvider } = vi.hoisted(() => {
	const addr = "0x0DeB8dFf035e7711f72fCde996D01f41bE4C883B" as const;
	return {
		ADDRESS: addr,
		mockOwsProvider: vi.fn().mockImplementation(() => ({
			getAddress: vi.fn().mockResolvedValue(addr),
			signMessage: vi.fn(),
			signTypedData: vi.fn(),
			signTransaction: vi.fn(),
			signAuthorization: vi.fn(),
		})),
	};
});

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: mockOwsProvider,
	};
});

describe("tap balance", () => {
	const { stdout: stdoutWrites } = useCapturedOutput();

	function buildConfig() {
		return buildTestConfig({
			chains: { "eip155:8453": TEST_BASE_CHAIN, "eip155:167000": TEST_TAIKO_CHAIN },
		});
	}

	beforeEach(() => {
		process.exitCode = undefined;
		vi.spyOn(configLoader, "loadConfig").mockResolvedValue(buildConfig());
		vi.spyOn(core, "getExecutionPreview").mockResolvedValue(
			buildMockExecutionPreview(ADDRESS, { paymasterProvider: "candide" }),
		);
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.clearAllMocks();
	});

	it("uses the configured chain by default and returns native plus USDC balances", async () => {
		const getBalance = vi.fn().mockResolvedValue(1234000000000000000n);
		const readContract = vi.fn().mockResolvedValue(9876543n);
		vi.spyOn(core, "buildChainPublicClient").mockReturnValue({
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
			status: string;
			data?: Record<string, unknown>;
		};
		expect(output.status).toBe("ok");
		expect(output.data?.address).toBe(ADDRESS);
		expect(output.data?.messaging_address).toBe(ADDRESS);
		expect(output.data?.execution_address).toBe(ADDRESS);
		expect(output.data?.chain).toBe("eip155:8453");
		expect(output.data?.execution_native_balance).toBe("1.234");
		expect(output.data?.execution_usdc_balance).toBe("9.876543");
	});

	it.each([
		["natural-language chain alias", "base"],
		["CAIP-2 chain identifier", "eip155:8453"],
	])("accepts a %s and resolves to eip155:8453", async (_, chainInput) => {
		vi.spyOn(core, "buildChainPublicClient").mockReturnValue({
			getBalance: vi.fn().mockResolvedValue(1n),
			readContract: vi.fn().mockResolvedValue(2n),
		} as never);

		await balanceCommand({ json: true }, chainInput);

		expect(core.buildChainPublicClient).toHaveBeenCalledWith(
			expect.objectContaining({ caip2: "eip155:8453" }),
		);
		const output = JSON.parse(stdoutWrites.join("")) as {
			data?: Record<string, unknown>;
		};
		expect(output.data?.chain).toBe("eip155:8453");
	});

	it("returns native plus USDC balances on Taiko", async () => {
		const readContract = vi.fn().mockResolvedValue(7654321n);
		vi.spyOn(core, "buildChainPublicClient").mockReturnValue({
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
		const buildPublicClientSpy = vi.spyOn(core, "buildChainPublicClient");

		await balanceCommand({ json: true }, "not-a-chain");

		expect(buildPublicClientSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			error?: Record<string, unknown>;
		};
		expect(output.status).toBe("error");
		expect(output.error?.code).toBe("VALIDATION_ERROR");
		expect(output.error?.message).toContain("Unknown chain");
	});
});
