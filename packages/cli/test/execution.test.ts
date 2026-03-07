import type { TrustedAgentsConfig } from "trusted-agents-core";
import { type Address, type Hex, encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENTRY_POINT_08 = "0x0000000000000000000000000000000000000008" as Address;
const EXECUTION_ADDRESS = "0x1000000000000000000000000000000000000001" as Address;
const CIRCLE_PAYMASTER_ADDRESS = "0x0578cFB241215b77442a541325d6A4E6dFE700Ec" as Address;
const CANDIDE_PAYMASTER_ADDRESS = "0x2000000000000000000000000000000000000002" as Address;
const OWNER_ADDRESS = privateKeyToAccount(
	"0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11",
).address;

const toSimple7702SmartAccount = vi.fn();
const createBundlerClient = vi.fn();
const createPaymasterClient = vi.fn();
const formatUserOperationRequest = vi.fn((value) => value);
const signAuthorization = vi.fn();
const buildPublicClient = vi.fn();
const buildWalletClient = vi.fn();

vi.mock("viem/account-abstraction", () => ({
	toSimple7702SmartAccount,
	createBundlerClient,
	createPaymasterClient,
	entryPoint08Address: ENTRY_POINT_08,
	formatUserOperationRequest,
}));

vi.mock("viem/actions", () => ({
	signAuthorization,
}));

vi.mock("../src/lib/wallet.js", () => ({
	buildPublicClient,
	buildWalletClient,
}));

function mockRpcFetch(
	handler: (request: { url: string; method: string; params: unknown[] }) =>
		| Response
		| Promise<Response>,
) {
	global.fetch = vi.fn(async (input, init) => {
		const payload = JSON.parse(String(init?.body ?? "{}")) as {
			method?: string;
			params?: unknown[];
		};
		return handler({
			url: String(input),
			method: payload.method ?? "",
			params: payload.params ?? [],
		});
	}) as typeof fetch;
}

function buildConfig(
	chain: string,
	executionOverrides?: TrustedAgentsConfig["execution"],
): TrustedAgentsConfig {
	const chainMap: TrustedAgentsConfig["chains"] = {
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
		"eip155:167000": {
			name: "Taiko",
			caip2: "eip155:167000",
			chainId: 167000,
			rpcUrl: "https://example.test/taiko",
			registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
		},
	};

	return {
		agentId: 1,
		chain,
		privateKey: "0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11",
		dataDir: "/tmp/tap",
		chains: chainMap,
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60000,
		resolveCacheMaxEntries: 100,
		xmtpEnv: "dev",
		xmtpDbEncryptionKey: undefined,
		execution: executionOverrides,
	};
}

function mock7702Account() {
	toSimple7702SmartAccount.mockResolvedValue({
		authorization: { address: EXECUTION_ADDRESS, account: { address: EXECUTION_ADDRESS } },
		getAddress: vi.fn().mockResolvedValue(EXECUTION_ADDRESS),
		signTypedData: vi
			.fn()
			.mockResolvedValue(
				"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1b",
			),
		signUserOperation: vi.fn().mockResolvedValue("0xuseropsig"),
	});
}

describe("execution", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		toSimple7702SmartAccount.mockReset();
		createBundlerClient.mockReset();
		createPaymasterClient.mockReset();
		formatUserOperationRequest.mockClear();
		signAuthorization.mockReset();
		buildPublicClient.mockReset();
		buildWalletClient.mockReset();
		global.fetch = vi.fn();
		mock7702Account();
		buildPublicClient.mockReturnValue({
			readContract: vi.fn().mockResolvedValue(maxUint256),
			verifyTypedData: vi.fn().mockResolvedValue(true),
			waitForTransactionReceipt: vi.fn(),
		});
		buildWalletClient.mockReturnValue({
			chain: { id: 84532 },
			sendTransaction: vi.fn(),
		});
		signAuthorization.mockResolvedValue({
			address: EXECUTION_ADDRESS,
			chainId: 84532,
			nonce: 1,
			r: "0x1",
			s: "0x2",
			yParity: 0,
		});
	});

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("defaults to eip7702 with Circle on Base Sepolia", async () => {
		const { getExecutionPreview } = await import("../src/lib/execution.js");
		const config = buildConfig("eip155:84532", undefined);
		const preview = await getExecutionPreview(config, config.chains[config.chain]!);

		expect(preview.requestedMode).toBe("eip7702");
		expect(preview.mode).toBe("eip7702");
		expect(preview.executionAddress).toBe(OWNER_ADDRESS);
		expect(preview.paymasterProvider).toBe("circle");
		expect(toSimple7702SmartAccount).toHaveBeenCalledOnce();
	});

	it("falls back to eoa on Taiko", async () => {
		const { getExecutionPreview } = await import("../src/lib/execution.js");
		const config = buildConfig("eip155:167000", {
			mode: "eip7702",
			paymasterProvider: "circle",
		});
		const preview = await getExecutionPreview(config, config.chains[config.chain]!);

		expect(preview.requestedMode).toBe("eip7702");
		expect(preview.mode).toBe("eoa");
		expect(preview.paymasterProvider).toBeUndefined();
		expect(preview.warnings[0]).toContain("zero-config account-abstraction path");
		expect(toSimple7702SmartAccount).not.toHaveBeenCalled();
	});

	it("uses Candide as the Base mainnet fallback when Circle preflight fails", async () => {
		buildWalletClient.mockReturnValue({
			chain: { id: 8453 },
			sendTransaction: vi.fn(),
		});
		mockRpcFetch(({ url, method }) => {
			if (url.includes("pimlico")) {
				return new Response(JSON.stringify({ error: { message: "bundler unavailable" } }), {
					status: 503,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (method === "eth_supportedEntryPoints") {
				return new Response(JSON.stringify({ result: [ENTRY_POINT_08] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (method === "pm_supportedERC20Tokens") {
				return new Response(
					JSON.stringify({
						result: {
							paymasterMetadata: { address: CANDIDE_PAYMASTER_ADDRESS },
							tokens: [
								{
									address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
									symbol: "USDC",
									decimals: "6",
								},
							],
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(JSON.stringify({ error: { message: `unexpected method ${method}` } }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		});

		const { getExecutionPreview } = await import("../src/lib/execution.js");
		const config = buildConfig("eip155:8453", {
			mode: "eip7702",
			paymasterProvider: "circle",
		});
		const preview = await getExecutionPreview(config, config.chains[config.chain]!, {
			requireProvider: true,
		});

		expect(preview.paymasterProvider).toBe("candide");
		expect(preview.warnings[0]).toContain("using Candide fallback");
	});

	it("honors a preview-selected paymaster provider during send", async () => {
		const readContract = vi.fn().mockResolvedValue(0n);
		buildPublicClient.mockReturnValue({
			readContract,
			verifyTypedData: vi.fn().mockResolvedValue(true),
			waitForTransactionReceipt: vi.fn(),
		});
		buildWalletClient.mockReturnValue({
			chain: { id: 8453 },
			sendTransaction: vi.fn(),
		});
		mockRpcFetch(({ method }) => {
			if (method === "eth_supportedEntryPoints") {
				return new Response(JSON.stringify({ result: [ENTRY_POINT_08] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (method === "pm_supportedERC20Tokens") {
				return new Response(
					JSON.stringify({
						result: {
							paymasterMetadata: { address: CANDIDE_PAYMASTER_ADDRESS },
							tokens: [
								{
									address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
									symbol: "USDC",
									decimals: "6",
								},
							],
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(JSON.stringify({ error: { message: `unexpected method ${method}` } }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		});
		createPaymasterClient.mockReturnValue({
			getPaymasterStubData: vi.fn().mockResolvedValue({
				paymaster: CANDIDE_PAYMASTER_ADDRESS,
				paymasterData: "0x",
				paymasterPostOpGasLimit: 1n,
				paymasterVerificationGasLimit: 1n,
			}),
			getPaymasterData: vi.fn().mockResolvedValue({
				paymaster: CANDIDE_PAYMASTER_ADDRESS,
				paymasterData: "0x",
				paymasterPostOpGasLimit: 1n,
				paymasterVerificationGasLimit: 1n,
			}),
		});
		const prepareUserOperation = vi.fn().mockResolvedValue({
			sender: EXECUTION_ADDRESS,
			callData: "0xdeadbeef" as Hex,
			callGasLimit: 3n,
			verificationGasLimit: 4n,
			preVerificationGas: 5n,
			maxFeePerGas: 2n,
			maxPriorityFeePerGas: 1n,
			nonce: 0n,
			factory: "0x7702000000000000000000000000000000000000" as Address,
			factoryData: "0x" as Hex,
		});
		createBundlerClient.mockReturnValue({
			prepareUserOperation,
			request: vi.fn().mockResolvedValue("0xuserophash"),
			waitForUserOperationReceipt: vi.fn().mockResolvedValue({
				receipt: {
					transactionHash: "0xtxhash",
					logs: [],
				},
			}),
		});

		const { executeContractCalls } = await import("../src/lib/execution.js");
		const config = buildConfig("eip155:8453", {
			mode: "eip7702",
			paymasterProvider: "circle",
		});
		const result = await executeContractCalls(
			config,
			config.chains[config.chain]!,
			[
				{
					to: "0x4000000000000000000000000000000000000004",
					data: "0x",
				},
			],
			{
				preview: {
					requestedMode: "eip7702",
					mode: "eip7702",
					paymasterProvider: "candide",
				},
			},
		);

		expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
		expect(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
			"candide.dev",
		);
		expect(prepareUserOperation).toHaveBeenCalledOnce();
		expect(prepareUserOperation.mock.calls[0]?.[0].calls).toEqual([
			{
				to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
				data: encodeFunctionData({
					abi: erc20Abi,
					functionName: "approve",
					args: [CANDIDE_PAYMASTER_ADDRESS, maxUint256],
				}),
			},
			{
				to: "0x4000000000000000000000000000000000000004",
				data: "0x",
			},
		]);
		expect(result.paymasterProvider).toBe("candide");
	});

	it("executes native eoa transactions on Taiko", async () => {
		const sendTransaction = vi.fn().mockResolvedValue("0xtxhash");
		const waitForTransactionReceipt = vi.fn().mockResolvedValue({
			transactionHash: "0xtxhash",
			logs: [],
		});
		buildWalletClient.mockReturnValue({
			chain: { id: 167000 },
			sendTransaction,
		});
		buildPublicClient.mockReturnValue({
			waitForTransactionReceipt,
			readContract: vi.fn(),
			verifyTypedData: vi.fn().mockResolvedValue(true),
		});

		const { executeContractCalls } = await import("../src/lib/execution.js");
		const config = buildConfig("eip155:167000", { mode: "eip7702" });
		const result = await executeContractCalls(config, config.chains[config.chain]!, [
			{
				to: "0x3000000000000000000000000000000000000003",
				data: "0x",
			},
		]);

		expect(sendTransaction).toHaveBeenCalledOnce();
		expect(result.mode).toBe("eoa");
		expect(result.gasPaymentMode).toBe("native");
		expect(result.userOperationHash).toBeUndefined();
	});

	it("stops eoa multi-call execution on the first reverted transaction", async () => {
		const sendTransaction = vi
			.fn()
			.mockResolvedValueOnce("0xtxhash1")
			.mockResolvedValueOnce("0xtxhash2");
		const waitForTransactionReceipt = vi.fn().mockResolvedValueOnce({
			transactionHash: "0xtxhash1",
			logs: [],
			status: "reverted",
		});
		buildWalletClient.mockReturnValue({
			chain: { id: 167000, name: "Taiko" },
			sendTransaction,
		});
		buildPublicClient.mockReturnValue({
			waitForTransactionReceipt,
			readContract: vi.fn(),
			verifyTypedData: vi.fn().mockResolvedValue(true),
		});

		const { executeContractCalls } = await import("../src/lib/execution.js");
		const config = buildConfig("eip155:167000", { mode: "eoa" });

		await expect(
			executeContractCalls(config, config.chains[config.chain]!, [
				{
					to: "0x3000000000000000000000000000000000000003",
					data: "0x",
				},
				{
					to: "0x3000000000000000000000000000000000000004",
					data: "0x",
				},
			]),
		).rejects.toThrow("Transaction 0xtxhash1 reverted on Taiko");

		expect(sendTransaction).toHaveBeenCalledTimes(1);
		expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
	});

	it("executes Base 7702 user operations with Circle", async () => {
		const readContract = vi
			.fn()
			.mockResolvedValueOnce("USD Coin")
			.mockResolvedValueOnce("2")
			.mockResolvedValueOnce(0n);
		buildPublicClient.mockReturnValue({
			readContract,
			verifyTypedData: vi.fn().mockResolvedValue(true),
			waitForTransactionReceipt: vi.fn(),
		});
		buildWalletClient.mockReturnValue({
			chain: { id: 8453 },
			sendTransaction: vi.fn(),
		});
		mockRpcFetch(({ method }) => {
			if (method === "eth_supportedEntryPoints") {
				return new Response(JSON.stringify({ result: [ENTRY_POINT_08] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ error: { message: `unexpected method ${method}` } }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		});

		createBundlerClient.mockReturnValue({
			prepareUserOperation: vi.fn(async (params) => {
				const paymasterResult = await params.paymaster.getPaymasterData({
					sender: EXECUTION_ADDRESS,
					maxFeePerGas: 2n,
					callGasLimit: 3n,
					verificationGasLimit: 4n,
					preVerificationGas: 5n,
					paymasterVerificationGasLimit: 6n,
					paymasterPostOpGasLimit: 7n,
				});
				return {
					sender: EXECUTION_ADDRESS,
					callData: "0xdeadbeef" as Hex,
					callGasLimit: 3n,
					verificationGasLimit: 4n,
					preVerificationGas: 5n,
					maxFeePerGas: 2n,
					maxPriorityFeePerGas: 1n,
					nonce: 0n,
					factory: "0x7702" as Address,
					factoryData: "0x" as Hex,
					authorization: params.authorization,
					...paymasterResult,
				};
			}),
			request: vi.fn().mockResolvedValue("0xuserophash"),
			waitForUserOperationReceipt: vi.fn().mockResolvedValue({
				receipt: {
					transactionHash: "0xtxhash",
					logs: [],
				},
			}),
		});

		const { executeContractCalls } = await import("../src/lib/execution.js");
		const config = buildConfig("eip155:8453", {
			mode: "eip7702",
			paymasterProvider: "circle",
		});
		const result = await executeContractCalls(config, config.chains[config.chain]!, [
			{
				to: "0x4000000000000000000000000000000000000004",
				data: "0x",
			},
		]);

		expect(signAuthorization).toHaveBeenCalledOnce();
		expect(createBundlerClient).toHaveBeenCalledOnce();
		expect(result.mode).toBe("eip7702");
		expect(result.paymasterProvider).toBe("circle");
		expect(result.paymasterAddress).toBe(CIRCLE_PAYMASTER_ADDRESS);
		expect(result.userOperationHash).toBe("0xuserophash");
		expect(result.gasPaymentMode).toBe("erc20-usdc");
		expect(formatUserOperationRequest).toHaveBeenCalledOnce();
	});
});
