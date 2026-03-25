import { http, type Hex, encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import {
	createBundlerClient,
	createPaymasterClient,
	formatUserOperationRequest,
	toSimple7702SmartAccount,
} from "viem/account-abstraction";
import type { PrivateKeyAccount } from "viem/accounts";
import { signAuthorization } from "viem/actions";
import {
	buildChainPublicClient as buildPublicClient,
	buildChainWalletClient as buildWalletClient,
} from "../common/index.js";
import type { ChainConfig, TrustedAgentsConfig } from "../config/types.js";
import type { SigningProvider } from "../signing/provider.js";
import { createSigningProviderViemAccount } from "../signing/viem-account.js";
import { getUsdcAsset } from "./assets.js";
import { CANDIDE_ALLOWANCE_BUFFER, ENTRY_POINT_08 } from "./execution/catalog.js";
import { createCirclePaymaster, warmCirclePermitMetadata } from "./execution/circle.js";
import {
	requestedExecutionMode,
	resolveExecutionMode,
	resolvePaymasterProvider,
} from "./execution/policy.js";
import {
	preflightProvider,
	previewProviderConfig,
	resolveAaProvider,
} from "./execution/providers.js";
import {
	createServoExecutionEvmSigner,
	deployServoExecutionAccountIfNeeded,
	executeServoEip4337Calls,
	resolveServoExecutionAddress,
} from "./execution/servo.js";
export type {
	ExecutionCall,
	ExecutionEvmSigner,
	ExecutionPreview,
	ExecutionSendResult,
} from "./execution/types.js";
import type {
	BaseExecutionContext,
	Eip7702ExecutionContext,
	EoaExecutionContext,
	ExecutionCall,
	ExecutionEvmSigner,
	ExecutionPreview,
	ExecutionSendResult,
	ResolvedExecutionContext,
} from "./execution/types.js";

async function resolveExecutionContext(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	provider: SigningProvider,
	{
		pinnedPreview,
		requireProvider,
	}: {
		pinnedPreview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode">;
		requireProvider: boolean;
	},
): Promise<ResolvedExecutionContext> {
	const warnings: string[] = [];
	const requestedMode = pinnedPreview?.requestedMode ?? requestedExecutionMode(config, chainConfig);
	const mode = pinnedPreview?.mode ?? resolveExecutionMode(chainConfig, requestedMode, warnings);
	const owner = await createSigningProviderViemAccount(provider);
	const publicClient = buildPublicClient(chainConfig);
	const walletClient = buildWalletClient(owner, chainConfig);
	const baseContext = {
		requestedMode,
		mode,
		messagingAddress: owner.address,
		executionAddress: owner.address,
		fundingAddress: owner.address,
		warnings,
		publicClient,
		walletClient,
		owner,
	} satisfies Omit<BaseExecutionContext, "paymasterProvider">;

	if (mode === "eoa") {
		return {
			...baseContext,
			mode,
		};
	}

	const paymasterProvider =
		pinnedPreview?.paymasterProvider ??
		resolvePaymasterProvider(config, chainConfig, mode, warnings);
	const providerConfig = requireProvider
		? pinnedPreview?.paymasterProvider
			? await preflightProvider(chainConfig, paymasterProvider)
			: await resolveAaProvider(chainConfig, paymasterProvider, warnings)
		: previewProviderConfig(chainConfig, paymasterProvider);

	if (!providerConfig && requireProvider) {
		throw new Error(`No zero-config paymaster is available on ${chainConfig.name}`);
	}

	if (!providerConfig && !requireProvider && mode !== "eip4337") {
		warnings.push(
			`${paymasterProvider} is not available as a zero-config paymaster on ${chainConfig.name}`,
		);
	}

	if (mode === "eip4337") {
		if (!providerConfig) {
			warnings.push(
				`${paymasterProvider} could not be resolved for ${chainConfig.name}; using eoa execution`,
			);
			return {
				...baseContext,
				mode: "eoa",
			};
		}

		if (!providerConfig.accountFactoryAddress) {
			throw new Error(`No Servo account factory is configured for ${chainConfig.name}`);
		}

		const executionAddress = await resolveServoExecutionAddress(
			publicClient,
			providerConfig.accountFactoryAddress,
			owner.address,
		);

		return {
			...baseContext,
			mode,
			executionAddress,
			fundingAddress: executionAddress,
			entryPoint: providerConfig.entryPoint,
			paymasterProvider: providerConfig.provider,
			providerConfig,
		};
	}

	const account = await toSimple7702SmartAccount({
		client: publicClient,
		owner: owner as unknown as PrivateKeyAccount,
		entryPoint: ENTRY_POINT_08.version,
	});

	return {
		...baseContext,
		mode,
		account,
		entryPoint: providerConfig?.entryPoint ?? ENTRY_POINT_08,
		paymasterProvider: providerConfig?.provider ?? paymasterProvider,
		providerConfig,
	};
}

export async function getExecutionPreview(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	provider: SigningProvider,
	{ requireProvider = false }: { requireProvider?: boolean } = {},
): Promise<ExecutionPreview> {
	const context = await resolveExecutionContext(config, chainConfig, provider, { requireProvider });
	return {
		requestedMode: context.requestedMode,
		mode: context.mode,
		messagingAddress: context.messagingAddress,
		executionAddress: context.executionAddress,
		fundingAddress: context.fundingAddress,
		paymasterProvider: context.paymasterProvider,
		warnings: context.warnings,
	};
}

export async function ensureExecutionReady(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	provider: SigningProvider,
	{
		preview,
		deployEip4337Account = false,
	}: {
		preview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode">;
		deployEip4337Account?: boolean;
	} = {},
): Promise<void> {
	const context = await resolveExecutionContext(config, chainConfig, provider, {
		pinnedPreview: preview,
		requireProvider: true,
	});

	if (deployEip4337Account && context.mode === "eip4337") {
		await deployServoExecutionAccountIfNeeded(context, chainConfig);
		return;
	}

	if (context.mode !== "eip7702" || context.providerConfig?.provider !== "circle") {
		return;
	}

	await warmCirclePermitMetadata(context, chainConfig);
}

export async function createExecutionEvmSigner(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	provider: SigningProvider,
	{
		preview,
	}: { preview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode"> } = {},
): Promise<ExecutionEvmSigner> {
	let context = await resolveExecutionContext(config, chainConfig, provider, {
		pinnedPreview: preview,
		requireProvider: false,
	});

	if (context.mode === "eip4337" && !context.providerConfig?.accountFactoryAddress) {
		context = await resolveExecutionContext(config, chainConfig, provider, {
			pinnedPreview: preview,
			requireProvider: true,
		});
	}

	const readContract: ExecutionEvmSigner["readContract"] = async (args) =>
		(await context.publicClient.readContract(args as never)) as unknown;

	if (context.mode === "eoa") {
		return {
			address: context.executionAddress,
			signTypedData: async (parameters) => await context.owner.signTypedData(parameters as never),
			readContract,
		};
	}

	if (context.mode === "eip7702") {
		return {
			address: context.executionAddress,
			signTypedData: async (parameters) => await context.account.signTypedData(parameters as never),
			readContract,
		};
	}

	return createServoExecutionEvmSigner(context, chainConfig);
}

async function executeEoaCalls(
	context: EoaExecutionContext,
	calls: ExecutionCall[],
): Promise<ExecutionSendResult> {
	let transactionHash: Hex | undefined;
	let transactionReceipt: ExecutionSendResult["transactionReceipt"] | undefined;

	for (const call of calls) {
		transactionHash = await context.walletClient.sendTransaction({
			account: context.owner,
			chain: context.walletClient.chain,
			to: call.to,
			data: call.data,
			value: call.value ?? 0n,
		});
		transactionReceipt = await context.publicClient.waitForTransactionReceipt({
			hash: transactionHash,
		});
		if (transactionReceipt.status === "reverted") {
			throw new Error(
				`Transaction ${transactionHash} reverted on ${context.walletClient.chain?.name ?? "this chain"}`,
			);
		}
	}

	if (!transactionHash || !transactionReceipt) {
		throw new Error("No transaction was sent");
	}

	return {
		requestedMode: context.requestedMode,
		mode: context.mode,
		messagingAddress: context.messagingAddress,
		executionAddress: context.executionAddress,
		fundingAddress: context.fundingAddress,
		paymasterProvider: context.paymasterProvider,
		warnings: context.warnings,
		gasPaymentMode: "native",
		transactionReceipt,
		transactionHash,
	};
}

async function executeEip7702Calls(
	context: Eip7702ExecutionContext,
	chainConfig: ChainConfig,
	calls: ExecutionCall[],
): Promise<ExecutionSendResult> {
	const providerConfig = context.providerConfig;
	if (!providerConfig) {
		throw new Error(`No paymaster provider is configured for ${chainConfig.name}`);
	}

	const bundlerClient = createBundlerClient({
		client: context.publicClient,
		transport: http(providerConfig.bundlerUrl),
	});

	const authorization = await signAuthorization(context.walletClient, {
		account: context.owner,
		contractAddress: context.account.authorization.address,
	});

	const usdc = getUsdcAsset(chainConfig.caip2);
	if (!usdc) {
		throw new Error(`No USDC asset config is available for ${chainConfig.name}`);
	}

	let preparedCalls = calls;
	if (providerConfig.provider === "candide" && providerConfig.paymasterAddress) {
		const allowance = (await context.publicClient.readContract({
			address: usdc.address,
			abi: erc20Abi,
			functionName: "allowance",
			args: [context.executionAddress, providerConfig.paymasterAddress],
		})) as bigint;
		if (allowance < CANDIDE_ALLOWANCE_BUFFER) {
			preparedCalls = [
				{
					to: usdc.address,
					data: encodeFunctionData({
						abi: erc20Abi,
						functionName: "approve",
						args: [providerConfig.paymasterAddress, maxUint256],
					}),
				},
				...calls,
			];
		}
	}

	const paymaster =
		providerConfig.provider === "circle"
			? createCirclePaymaster(context, chainConfig, providerConfig.paymasterAddress!)
			: (() => {
					const paymasterClient = createPaymasterClient({
						transport: http(providerConfig.paymasterUrl!),
					});
					return {
						getPaymasterStubData: paymasterClient.getPaymasterStubData,
						getPaymasterData: paymasterClient.getPaymasterData,
					};
				})();

	const preparedUserOperationWithContext = await bundlerClient.prepareUserOperation({
		account: context.account,
		authorization,
		calls: preparedCalls,
		paymaster,
		...(providerConfig.provider === "candide" ? { paymasterContext: { token: usdc.address } } : {}),
	});
	const { account: _account, ...preparedUserOperation } =
		preparedUserOperationWithContext as typeof preparedUserOperationWithContext & {
			account?: unknown;
		};
	const userOperationSignature = await context.account.signUserOperation(
		preparedUserOperation as Parameters<typeof context.account.signUserOperation>[0],
	);
	const userOperationHash = await bundlerClient.request(
		{
			method: "eth_sendUserOperation",
			params: [
				formatUserOperationRequest({
					...preparedUserOperation,
					signature: userOperationSignature,
				} as never),
				context.entryPoint.address,
			],
		},
		{ retryCount: 0 },
	);
	const userOperationReceipt = await bundlerClient.waitForUserOperationReceipt({
		hash: userOperationHash,
	});
	if (userOperationReceipt.receipt.status === "reverted") {
		throw new Error(
			`User operation ${userOperationHash} reverted in transaction ${userOperationReceipt.receipt.transactionHash}`,
		);
	}

	return {
		requestedMode: context.requestedMode,
		mode: context.mode,
		messagingAddress: context.messagingAddress,
		executionAddress: context.executionAddress,
		fundingAddress: context.fundingAddress,
		paymasterProvider: context.paymasterProvider,
		warnings: context.warnings,
		entryPointAddress: context.entryPoint.address,
		entryPointVersion: context.entryPoint.version,
		gasPaymentMode: "erc20-usdc",
		paymasterAddress: providerConfig.paymasterAddress,
		transactionReceipt: userOperationReceipt.receipt,
		transactionHash: userOperationReceipt.receipt.transactionHash,
		userOperationHash,
	};
}

export async function executeContractCalls(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	provider: SigningProvider,
	calls: ExecutionCall[],
	{
		preview,
	}: { preview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode"> } = {},
): Promise<ExecutionSendResult> {
	const context = await resolveExecutionContext(config, chainConfig, provider, {
		pinnedPreview: preview,
		requireProvider: true,
	});

	if (context.mode === "eoa") {
		return executeEoaCalls(context, calls);
	}

	if (context.mode === "eip7702") {
		return executeEip7702Calls(context, chainConfig, calls);
	}

	return executeServoEip4337Calls(context, chainConfig, calls);
}
