import { type Address, type Hex, encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";

const ENTRY_POINT_07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const ENTRY_POINT_08 = "0x0000000000000000000000000000000000000008" as Address;
const EXECUTION_ADDRESS = "0x1000000000000000000000000000000000000001" as Address;
const CIRCLE_PAYMASTER_ADDRESS = "0x0578cFB241215b77442a541325d6A4E6dFE700Ec" as Address;
const CANDIDE_PAYMASTER_ADDRESS = "0x2000000000000000000000000000000000000002" as Address;
const SERVO_FACTORY_ADDRESS = "0xCa245Ae9B786EF420Dc359430e5833b840880619" as Address;
const OWNER_ADDRESS = privateKeyToAccount(
	"0x59c6995e998f97a5a0044966f094538b292b1cf3e3d7e1e6df3f2b9e6c7d3f11",
).address;

const toSimple7702SmartAccount = vi.fn();
const createBundlerClient = vi.fn();
const createPaymasterClient = vi.fn();
const formatUserOperationRequest = vi.fn((value) => value);
const getUserOperationHash = vi.fn();
const signAuthorization = vi.fn();
const buildChainPublicClient = vi.fn();
const buildChainWalletClient = vi.fn();

vi.mock("viem/account-abstraction", () => ({
	toSimple7702SmartAccount,
	createBundlerClient,
	createPaymasterClient,
	entryPoint07Address: ENTRY_POINT_07,
	entryPoint08Address: ENTRY_POINT_08,
	formatUserOperationRequest,
	getUserOperationHash,
}));

vi.mock("viem/actions", () => ({
	signAuthorization,
}));

vi.mock("../../../src/common/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/common/index.js")>();
	return {
		...actual,
		buildChainPublicClient,
		buildChainWalletClient,
	};
});

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
		getUserOperationHash.mockReset();
		signAuthorization.mockReset();
		buildChainPublicClient.mockReset();
		buildChainWalletClient.mockReset();
		global.fetch = vi.fn();
		mock7702Account();
		getUserOperationHash.mockReturnValue(`0x${"ab".repeat(32)}`);
		buildChainPublicClient.mockReturnValue({
			readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
				if (functionName === "getAddress") return EXECUTION_ADDRESS;
				if (functionName === "getNonce") return 0n;
				if (functionName === "nonces") return 0n;
				if (functionName === "name") return "USD Coin";
				if (functionName === "version") return "2";
				return maxUint256;
			}),
			verifyTypedData: vi.fn().mockResolvedValue(true),
			waitForTransactionReceipt: vi.fn(),
			estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
			getGasPrice: vi.fn().mockResolvedValue(2n),
		});
		buildChainWalletClient.mockReturnValue({
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
		const { getExecutionPreview } = await import("../../../src/runtime/execution.js");
		const config = buildConfig("eip155:84532", undefined);
		const preview = await getExecutionPreview(config, config.chains[config.chain]!);

		expect(preview.requestedMode).toBe("eip7702");
		expect(preview.mode).toBe("eip7702");
		expect(preview.executionAddress).toBe(OWNER_ADDRESS);
		expect(preview.paymasterProvider).toBe("circle");
		expect(toSimple7702SmartAccount).toHaveBeenCalledOnce();
	});

	it("coerces Base eip4337 requests back to an eip7702-compatible paymaster", async () => {
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

		const { getExecutionPreview } = await import("../../../src/runtime/execution.js");
		const config = buildConfig("eip155:8453", {
			mode: "eip4337",
			paymasterProvider: "servo",
		});
		const preview = await getExecutionPreview(config, config.chains[config.chain]!, {
			requireProvider: true,
		});

		expect(preview.mode).toBe("eip7702");
		expect(preview.paymasterProvider).toBe("circle");
		expect(preview.warnings).toContain(
			"Base uses EIP-7702 as the default account-abstraction path in this runtime; using eip7702",
		);
		expect(preview.warnings).toContain(
			"servo is not available for eip7702 execution on Base; using circle",
		);
	});

	it("switches Taiko requests to eip4337 with Servo", async () => {
		mockRpcFetch(({ method }) => {
			if (method === "eth_supportedEntryPoints") {
				return new Response(JSON.stringify({ result: [ENTRY_POINT_07] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (method === "pm_getCapabilities") {
				return new Response(
					JSON.stringify({
						result: {
							accountFactoryAddress: SERVO_FACTORY_ADDRESS,
							supportedChains: [{ chainId: 167000 }],
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

		const { getExecutionPreview } = await import("../../../src/runtime/execution.js");
		const config = buildConfig("eip155:167000", {
			mode: "eip7702",
			paymasterProvider: "servo",
		});
		const preview = await getExecutionPreview(config, config.chains[config.chain]!, {
			requireProvider: true,
		});

		expect(preview.requestedMode).toBe("eip7702");
		expect(preview.mode).toBe("eip4337");
		expect(preview.paymasterProvider).toBe("servo");
		expect(preview.executionAddress).toBe(EXECUTION_ADDRESS);
		expect(preview.warnings[0]).toContain("uses EIP-4337");
		expect(toSimple7702SmartAccount).not.toHaveBeenCalled();
	});

	it("fails fast when Servo explicitly reports the chain as unsupported", async () => {
		mockRpcFetch(({ method }) => {
			if (method === "eth_supportedEntryPoints") {
				return new Response(JSON.stringify({ result: [ENTRY_POINT_07] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (method === "pm_getCapabilities") {
				return new Response(
					JSON.stringify({
						result: {
							accountFactoryAddress: SERVO_FACTORY_ADDRESS,
							supportedChains: [{ chainId: 8453 }],
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

		const { getExecutionPreview } = await import("../../../src/runtime/execution.js");
		const config = buildConfig("eip155:167000", {
			mode: "eip4337",
			paymasterProvider: "servo",
		});

		await expect(
			getExecutionPreview(config, config.chains[config.chain]!, {
				requireProvider: true,
			}),
		).rejects.toThrow("Servo endpoint does not advertise Taiko");
	});

	it("uses Candide as the Base mainnet fallback when Circle preflight fails", async () => {
		buildChainWalletClient.mockReturnValue({
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

		const { getExecutionPreview } = await import("../../../src/runtime/execution.js");
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
		buildChainPublicClient.mockReturnValue({
			readContract,
			verifyTypedData: vi.fn().mockResolvedValue(true),
			waitForTransactionReceipt: vi.fn(),
		});
		buildChainWalletClient.mockReturnValue({
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

		const { executeContractCalls } = await import("../../../src/runtime/execution.js");
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
		buildChainWalletClient.mockReturnValue({
			chain: { id: 167000 },
			sendTransaction,
		});
		buildChainPublicClient.mockReturnValue({
			waitForTransactionReceipt,
			readContract: vi.fn(),
			verifyTypedData: vi.fn().mockResolvedValue(true),
		});

		const { executeContractCalls } = await import("../../../src/runtime/execution.js");
		const config = buildConfig("eip155:167000", { mode: "eoa" });
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

	it("executes Taiko 4337 user operations with Servo", async () => {
		const requests: Array<{ method: string; params: unknown[] }> = [];
		const readContract = vi.fn(
			async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
				if (functionName === "getAddress") return EXECUTION_ADDRESS;
				if (functionName === "getNonce") return 0n;
				if (functionName === "nonces") {
					if (args?.[0] !== OWNER_ADDRESS) {
						throw new Error("permit nonce must be loaded for EOA owner");
					}
					return 7n;
				}
				if (functionName === "name") return "USD Coin";
				if (functionName === "version") return "2";
				throw new Error(`unexpected function ${functionName}`);
			},
		);
		buildChainPublicClient.mockReturnValue({
			readContract,
			verifyTypedData: vi.fn().mockResolvedValue(true),
			waitForTransactionReceipt: vi.fn(),
			estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
			getGasPrice: vi.fn().mockResolvedValue(2n),
			getCode: vi.fn().mockResolvedValue("0x"),
		});
		buildChainWalletClient.mockReturnValue({
			chain: { id: 167000 },
			sendTransaction: vi.fn(),
		});
		mockRpcFetch(({ method, params }) => {
			requests.push({ method, params });
			if (method === "eth_supportedEntryPoints") {
				return new Response(JSON.stringify({ result: [ENTRY_POINT_07] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (method === "pm_getCapabilities") {
				return new Response(
					JSON.stringify({
						result: {
							accountFactoryAddress: SERVO_FACTORY_ADDRESS,
							supportedChains: [{ chainId: 167000 }],
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (method === "pm_getPaymasterStubData" || method === "pm_getPaymasterData") {
				return new Response(
					JSON.stringify({
						result: {
							paymaster: "0x9999999999999999999999999999999999999999",
							paymasterData: "0x12",
							paymasterAndData: "0x999999999999999999999999999999999999999912",
							callGasLimit: "0x88d8",
							verificationGasLimit: "0x1d4c8",
							preVerificationGas: "0x5274",
							paymasterVerificationGasLimit: "0xea60",
							paymasterPostOpGasLimit: "0xafc8",
							tokenAddress: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
							maxTokenCostMicros: "1000000",
							validUntil: 1900000000,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (method === "eth_sendUserOperation") {
				return new Response(
					JSON.stringify({
						result: "0xservohash",
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

		createBundlerClient.mockReturnValue({
			waitForUserOperationReceipt: vi.fn().mockResolvedValue({
				receipt: {
					transactionHash: "0xservotx",
					logs: [],
				},
			}),
		});

		const { executeContractCalls } = await import("../../../src/runtime/execution.js");
		const config = buildConfig("eip155:167000", {
			mode: "eip4337",
			paymasterProvider: "servo",
		});
		const result = await executeContractCalls(config, config.chains[config.chain]!, [
			{
				to: "0x3000000000000000000000000000000000000003",
				data: "0x1234",
			},
		]);

		expect(result.mode).toBe("eip4337");
		expect(result.paymasterProvider).toBe("servo");
		expect(result.gasPaymentMode).toBe("erc20-usdc");
		expect(result.entryPointVersion).toBe("0.7");
		expect(result.paymasterAddress).toBe("0x9999999999999999999999999999999999999999");
		expect(result.userOperationHash).toBe("0xservohash");
		expect(createBundlerClient).toHaveBeenCalledOnce();
		expect(getUserOperationHash).toHaveBeenCalledOnce();
		expect(toSimple7702SmartAccount).not.toHaveBeenCalled();
		expect(readContract).toHaveBeenCalledWith(
			expect.objectContaining({
				functionName: "nonces",
				args: [OWNER_ADDRESS],
			}),
		);
		const stubRequest = requests.find((request) => request.method === "pm_getPaymasterStubData");
		const stubUserOperation = stubRequest?.params[0] as Record<string, unknown>;
		expect(stubRequest?.params[2]).toBe("0x28c58");
		expect(stubUserOperation.factory).toBe(SERVO_FACTORY_ADDRESS);
		expect(stubUserOperation).toHaveProperty("factoryData");
		expect(stubUserOperation).not.toHaveProperty("initCode");
		const paymasterDataRequest = requests.find(
			(request) => request.method === "pm_getPaymasterData",
		);
		const quotedUserOperation = paymasterDataRequest?.params[0] as Record<string, unknown>;
		expect(paymasterDataRequest?.params[2]).toBe("0x28c58");
		expect(quotedUserOperation.callGasLimit).toBe("0x88d8");
		expect(quotedUserOperation.verificationGasLimit).toBe("0x1d4c8");
		expect(quotedUserOperation.preVerificationGas).toBe("0x5274");
		const sendRequest = requests.find((request) => request.method === "eth_sendUserOperation");
		const sentUserOperation = sendRequest?.params[0] as Record<string, unknown>;
		expect(sentUserOperation.factory).toBe(SERVO_FACTORY_ADDRESS);
		expect(sentUserOperation).toHaveProperty("factoryData");
		expect(sentUserOperation).not.toHaveProperty("initCode");
		expect(sentUserOperation).not.toHaveProperty("paymasterAndData");
	});

	it("omits Servo factory deployment fields when account is already deployed", async () => {
		const requests: Array<{ method: string; params: unknown[] }> = [];
		buildChainPublicClient.mockReturnValue({
			readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
				if (functionName === "getAddress") return EXECUTION_ADDRESS;
				if (functionName === "getNonce") return 11n;
				if (functionName === "nonces") return 8n;
				if (functionName === "name") return "USD Coin";
				if (functionName === "version") return "2";
				throw new Error(`unexpected function ${functionName}`);
			}),
			verifyTypedData: vi.fn().mockResolvedValue(true),
			waitForTransactionReceipt: vi.fn(),
			estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
			getGasPrice: vi.fn().mockResolvedValue(2n),
			getCode: vi.fn().mockResolvedValue("0x6001600155"),
		});
		buildChainWalletClient.mockReturnValue({
			chain: { id: 167000 },
			sendTransaction: vi.fn(),
		});
		mockRpcFetch(({ method, params }) => {
			requests.push({ method, params });
			if (method === "eth_supportedEntryPoints") {
				return new Response(JSON.stringify({ result: [ENTRY_POINT_07] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (method === "pm_getCapabilities") {
				return new Response(
					JSON.stringify({
						result: {
							accountFactoryAddress: SERVO_FACTORY_ADDRESS,
							supportedChains: [{ chainId: 167000 }],
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (method === "pm_getPaymasterStubData" || method === "pm_getPaymasterData") {
				return new Response(
					JSON.stringify({
						result: {
							paymaster: "0x9999999999999999999999999999999999999999",
							paymasterData: "0x12",
							paymasterAndData: "0x999999999999999999999999999999999999999912",
							callGasLimit: "0x88d8",
							verificationGasLimit: "0x1d4c8",
							preVerificationGas: "0x5274",
							paymasterVerificationGasLimit: "0xea60",
							paymasterPostOpGasLimit: "0xafc8",
							tokenAddress: "0x07d83526730c7438048D55A4fc0b850e2aaB6f0b",
							maxTokenCostMicros: "1000000",
							validUntil: 1900000000,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (method === "eth_sendUserOperation") {
				return new Response(
					JSON.stringify({
						result: "0xservohash",
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
		createBundlerClient.mockReturnValue({
			waitForUserOperationReceipt: vi.fn().mockResolvedValue({
				receipt: {
					transactionHash: "0xservotx",
					logs: [],
				},
			}),
		});

		const { executeContractCalls } = await import("../../../src/runtime/execution.js");
		const config = buildConfig("eip155:167000", {
			mode: "eip4337",
			paymasterProvider: "servo",
		});
		await executeContractCalls(config, config.chains[config.chain]!, [
			{
				to: "0x3000000000000000000000000000000000000003",
				data: "0x1234",
			},
		]);

		const stubRequest = requests.find((request) => request.method === "pm_getPaymasterStubData");
		const stubUserOperation = stubRequest?.params[0] as Record<string, unknown>;
		expect(stubUserOperation).not.toHaveProperty("factory");
		expect(stubUserOperation).not.toHaveProperty("factoryData");
		expect(stubUserOperation).not.toHaveProperty("initCode");
		const sendRequest = requests.find((request) => request.method === "eth_sendUserOperation");
		const sentUserOperation = sendRequest?.params[0] as Record<string, unknown>;
		expect(sentUserOperation).not.toHaveProperty("factory");
		expect(sentUserOperation).not.toHaveProperty("factoryData");
		expect(sentUserOperation).not.toHaveProperty("initCode");
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
		buildChainWalletClient.mockReturnValue({
			chain: { id: 167000, name: "Taiko" },
			sendTransaction,
		});
		buildChainPublicClient.mockReturnValue({
			waitForTransactionReceipt,
			readContract: vi.fn(),
			verifyTypedData: vi.fn().mockResolvedValue(true),
		});

		const { executeContractCalls } = await import("../../../src/runtime/execution.js");
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
		buildChainPublicClient.mockReturnValue({
			readContract,
			verifyTypedData: vi.fn().mockResolvedValue(true),
			waitForTransactionReceipt: vi.fn(),
		});
		buildChainWalletClient.mockReturnValue({
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

		const { executeContractCalls } = await import("../../../src/runtime/execution.js");
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
