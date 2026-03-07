import {
	type ChainConfig,
	DEFAULT_CONFIG,
	type ExecutionMode,
	type ExecutionPaymasterProvider,
	type TrustedAgentsConfig,
} from "trusted-agents-core";
import {
	http,
	type Address,
	type Hex,
	type TransactionReceipt,
	encodeFunctionData,
	encodePacked,
	erc20Abi,
	getAddress,
	maxUint256,
	parseErc6492Signature,
} from "viem";
import {
	createBundlerClient,
	createPaymasterClient,
	entryPoint08Address,
	formatUserOperationRequest,
	toSimple7702SmartAccount,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { signAuthorization } from "viem/actions";
import { getUsdcAsset } from "./assets.js";
import { getDefaultExecutionModeForChain } from "./config-loader.js";
import { buildPublicClient, buildWalletClient } from "./wallet.js";

type EntryPointVersion = "0.8";
type GasPaymentMode = "erc20-usdc" | "native";

interface EntryPointConfig {
	address: Address;
	version: EntryPointVersion;
}

interface SupportedErc20Token {
	address: Address;
	decimals?: string;
	symbol?: string;
}

interface SupportedErc20TokensResponse {
	paymasterMetadata?: {
		address?: Address;
	};
	tokens?: SupportedErc20Token[];
}

interface CirclePermitMetadata {
	usdcAddress: Address;
	name: string;
	version: string;
	nonce: bigint;
}

interface AaProviderConfig {
	provider: ExecutionPaymasterProvider;
	bundlerUrl: string;
	paymasterUrl?: string;
	paymasterAddress?: Address;
}

interface BaseExecutionContext {
	requestedMode: ExecutionMode;
	mode: "eoa" | "eip7702";
	messagingAddress: Address;
	executionAddress: Address;
	fundingAddress: Address;
	paymasterProvider?: ExecutionPaymasterProvider;
	warnings: string[];
	publicClient: ReturnType<typeof buildPublicClient>;
	walletClient: ReturnType<typeof buildWalletClient>;
	owner: ReturnType<typeof privateKeyToAccount>;
}

interface EoaExecutionContext extends BaseExecutionContext {
	mode: "eoa";
}

interface AaExecutionContext extends BaseExecutionContext {
	mode: "eip7702";
	account: Awaited<ReturnType<typeof toSimple7702SmartAccount>>;
	entryPoint: EntryPointConfig;
	providerConfig?: AaProviderConfig;
}

type ResolvedExecutionContext = EoaExecutionContext | AaExecutionContext;

export interface ExecutionPreview {
	requestedMode: ExecutionMode;
	mode: "eoa" | "eip7702";
	messagingAddress: Address;
	executionAddress: Address;
	fundingAddress: Address;
	paymasterProvider?: ExecutionPaymasterProvider;
	warnings: string[];
}

export interface ExecutionSendResult extends ExecutionPreview {
	entryPointAddress?: Address;
	entryPointVersion?: EntryPointVersion;
	gasPaymentMode: GasPaymentMode;
	paymasterAddress?: Address;
	transactionReceipt: TransactionReceipt;
	transactionHash: Hex;
	userOperationHash?: Hex;
}

const ENTRY_POINT = {
	address: entryPoint08Address,
	version: "0.8",
} as const satisfies EntryPointConfig;

const CIRCLE_BUNDLER_URLS: Partial<Record<string, string>> = {
	"eip155:8453": "https://public.pimlico.io/v2/8453/rpc",
	"eip155:84532": "https://public.pimlico.io/v2/84532/rpc",
};

const CIRCLE_PAYMASTER_ADDRESSES: Partial<Record<string, Address>> = {
	"eip155:8453": "0x0578cFB241215b77442a541325d6A4E6dFE700Ec",
	"eip155:84532": "0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966",
};

const CANDIDE_ENDPOINTS: Partial<Record<string, string>> = {
	"eip155:8453": "https://api.candide.dev/public/v3/8453",
};

const CIRCLE_PAYMASTER_VERIFICATION_GAS_LIMIT = 200_000n;
const CIRCLE_PAYMASTER_POST_OP_GAS_LIMIT = 15_000n;
const CIRCLE_PERMIT_AMOUNT = 10_000_000n;
const CANDIDE_ALLOWANCE_BUFFER = 1_000_000n;
const CIRCLE_PERMIT_METADATA_CACHE = new Map<string, CirclePermitMetadata>();

const ERC20_NAME_ABI = [
	{
		type: "function",
		name: "name",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "string" }],
	},
] as const;

const ERC20_VERSION_ABI = [
	{
		type: "function",
		name: "version",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "string" }],
	},
] as const;

const ERC20_NONCES_ABI = [
	{
		type: "function",
		name: "nonces",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const;

const USDC_PERMIT_TYPES = {
	EIP712Domain: [
		{ name: "name", type: "string" },
		{ name: "version", type: "string" },
		{ name: "chainId", type: "uint256" },
		{ name: "verifyingContract", type: "address" },
	],
	Permit: [
		{ name: "owner", type: "address" },
		{ name: "spender", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
	],
} as const;

function isBaseChain(chainConfig: ChainConfig): boolean {
	return chainConfig.chainId === 8453 || chainConfig.chainId === 84532;
}

function circlePermitCacheKey(chain: string, sender: Address): string {
	return `${chain}:${sender.toLowerCase()}`;
}

function cacheCirclePermitMetadata(
	chain: string,
	sender: Address,
	metadata: CirclePermitMetadata,
): void {
	CIRCLE_PERMIT_METADATA_CACHE.set(circlePermitCacheKey(chain, sender), metadata);
}

function takeCachedCirclePermitMetadata(
	chain: string,
	sender: Address,
): CirclePermitMetadata | undefined {
	const key = circlePermitCacheKey(chain, sender);
	const cached = CIRCLE_PERMIT_METADATA_CACHE.get(key);
	if (cached) {
		CIRCLE_PERMIT_METADATA_CACHE.delete(key);
	}
	return cached;
}

function requestedExecutionMode(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
): ExecutionMode {
	return config.execution?.mode ?? getDefaultExecutionModeForChain(chainConfig.caip2);
}

function resolveExecutionMode(
	chainConfig: ChainConfig,
	requestedMode: ExecutionMode,
	warnings: string[],
): "eoa" | "eip7702" {
	if (requestedMode === "eoa") {
		return "eoa";
	}

	if (!isBaseChain(chainConfig)) {
		warnings.push(
			`${chainConfig.name} does not have a zero-config account-abstraction path in this CLI yet; using eoa`,
		);
		return "eoa";
	}

	if (requestedMode === "eip4337") {
		warnings.push(
			`${chainConfig.name} uses EIP-7702 as the default account-abstraction path in this CLI; using eip7702`,
		);
	}

	return "eip7702";
}

function requestedPaymasterProvider(config: TrustedAgentsConfig): ExecutionPaymasterProvider {
	return (
		config.execution?.paymasterProvider ?? DEFAULT_CONFIG.execution?.paymasterProvider ?? "circle"
	);
}

function previewProviderConfig(
	chainConfig: ChainConfig,
	provider: ExecutionPaymasterProvider,
): AaProviderConfig | undefined {
	if (provider === "circle") {
		const bundlerUrl = CIRCLE_BUNDLER_URLS[chainConfig.caip2];
		const paymasterAddress = CIRCLE_PAYMASTER_ADDRESSES[chainConfig.caip2];
		if (!bundlerUrl || !paymasterAddress) {
			return undefined;
		}

		return {
			provider,
			bundlerUrl,
			paymasterAddress,
		};
	}

	const endpoint = CANDIDE_ENDPOINTS[chainConfig.caip2];
	if (!endpoint) {
		return undefined;
	}

	return {
		provider,
		bundlerUrl: endpoint,
		paymasterUrl: endpoint,
	};
}

function providerCandidates(
	chainConfig: ChainConfig,
	provider: ExecutionPaymasterProvider,
): ExecutionPaymasterProvider[] {
	if (provider === "circle" && chainConfig.chainId === 8453) {
		return ["circle", "candide"];
	}

	return [provider];
}

async function rpcRequest<TResult>(
	url: string,
	method: string,
	params: unknown[],
): Promise<TResult> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method,
			params,
		}),
		signal: AbortSignal.timeout(10_000),
	});

	let payload:
		| {
				result?: TResult;
				error?: { message?: string };
		  }
		| undefined;
	try {
		payload = (await response.json()) as {
			result?: TResult;
			error?: { message?: string };
		};
	} catch {
		throw new Error(`RPC ${method} returned a non-JSON response`);
	}
	if (!response.ok || payload.result === undefined) {
		throw new Error(payload.error?.message ?? `RPC ${method} failed with HTTP ${response.status}`);
	}

	return payload.result;
}

async function assertBundlerSupportsEntryPoint(bundlerUrl: string): Promise<void> {
	const supported = await rpcRequest<string[]>(bundlerUrl, "eth_supportedEntryPoints", []);
	if (!supported.some((address) => address.toLowerCase() === ENTRY_POINT.address.toLowerCase())) {
		throw new Error(`Bundler does not expose EntryPoint ${ENTRY_POINT.version}`);
	}
}

async function resolveSupportedToken(
	paymasterUrl: string,
	entryPointAddress: Address,
	chain: string,
): Promise<{ token: SupportedErc20Token; paymasterAddress?: Address } | null> {
	const usdc = getUsdcAsset(chain);
	if (!usdc) return null;

	const response = await rpcRequest<SupportedErc20TokensResponse>(
		paymasterUrl,
		"pm_supportedERC20Tokens",
		[entryPointAddress],
	);

	const token = response.tokens?.find(
		(candidate) => candidate.address.toLowerCase() === usdc.address.toLowerCase(),
	);
	if (!token) {
		return null;
	}

	return {
		token: {
			...token,
			address: getAddress(token.address),
		},
		paymasterAddress: response.paymasterMetadata?.address
			? getAddress(response.paymasterMetadata.address)
			: undefined,
	};
}

async function preflightProvider(
	chainConfig: ChainConfig,
	provider: ExecutionPaymasterProvider,
): Promise<AaProviderConfig> {
	if (provider === "circle") {
		const bundlerUrl = CIRCLE_BUNDLER_URLS[chainConfig.caip2];
		const paymasterAddress = CIRCLE_PAYMASTER_ADDRESSES[chainConfig.caip2];
		if (!bundlerUrl || !paymasterAddress) {
			throw new Error(
				`Circle Paymaster is not available as a zero-config option on ${chainConfig.name}`,
			);
		}

		await assertBundlerSupportsEntryPoint(bundlerUrl);
		return {
			provider,
			bundlerUrl,
			paymasterAddress,
		};
	}

	const endpoint = CANDIDE_ENDPOINTS[chainConfig.caip2];
	if (!endpoint) {
		throw new Error(
			`Candide is not available as a zero-config USDC paymaster on ${chainConfig.name}`,
		);
	}

	await assertBundlerSupportsEntryPoint(endpoint);
	const tokenSupport = await resolveSupportedToken(
		endpoint,
		ENTRY_POINT.address,
		chainConfig.caip2,
	);
	if (!tokenSupport) {
		throw new Error(`Candide does not advertise USDC gas payment on ${chainConfig.name}`);
	}

	return {
		provider,
		bundlerUrl: endpoint,
		paymasterUrl: endpoint,
		paymasterAddress: tokenSupport.paymasterAddress,
	};
}

async function resolveAaProvider(
	chainConfig: ChainConfig,
	provider: ExecutionPaymasterProvider,
	warnings: string[],
): Promise<AaProviderConfig> {
	let lastError: Error | undefined;

	for (const candidate of providerCandidates(chainConfig, provider)) {
		try {
			const resolved = await preflightProvider(chainConfig, candidate);
			if (candidate !== provider && lastError) {
				warnings.push(
					`Circle preflight failed on ${chainConfig.name}; using Candide fallback: ${lastError.message}`,
				);
			}
			return resolved;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw lastError ?? new Error(`No zero-config paymaster is available on ${chainConfig.name}`);
}
async function loadCirclePermitMetadata(
	publicClient: ReturnType<typeof buildPublicClient>,
	chainConfig: ChainConfig,
	sender: Address,
): Promise<CirclePermitMetadata> {
	const usdc = getUsdcAsset(chainConfig.caip2);
	if (!usdc) {
		throw new Error(`No USDC asset config is available for ${chainConfig.name}`);
	}

	let name: string;
	let version: string;
	let nonce: bigint;
	try {
		[name, version, nonce] = await Promise.all([
			publicClient.readContract({
				address: usdc.address,
				abi: ERC20_NAME_ABI,
				functionName: "name",
			}),
			publicClient.readContract({
				address: usdc.address,
				abi: ERC20_VERSION_ABI,
				functionName: "version",
			}),
			publicClient.readContract({
				address: usdc.address,
				abi: ERC20_NONCES_ABI,
				functionName: "nonces",
				args: [sender],
			}),
		]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("429") || /rate limit/i.test(message)) {
			throw new Error(
				`${chainConfig.name} RPC rate-limited the Circle permit preflight. Retry shortly or set chains.${chainConfig.caip2}.rpc_url to a less rate-limited RPC endpoint.`,
			);
		}
		throw error;
	}

	return {
		usdcAddress: usdc.address,
		name,
		version,
		nonce,
	};
}

async function buildCirclePaymasterResponse(
	account: Awaited<ReturnType<typeof toSimple7702SmartAccount>>,
	publicClient: ReturnType<typeof buildPublicClient>,
	chainConfig: ChainConfig,
	paymasterAddress: Address,
	permitMetadata: CirclePermitMetadata,
	parameters: {
		sender: Address;
		isFinal?: boolean;
	},
): Promise<{
	paymaster: Address;
	paymasterData: Hex;
	paymasterPostOpGasLimit: bigint;
	paymasterVerificationGasLimit: bigint;
	isFinal?: boolean;
}> {
	const typedData = {
		domain: {
			name: permitMetadata.name,
			version: permitMetadata.version,
			chainId: BigInt(chainConfig.chainId),
			verifyingContract: permitMetadata.usdcAddress,
		},
		types: USDC_PERMIT_TYPES,
		primaryType: "Permit" as const,
		message: {
			owner: parameters.sender,
			spender: paymasterAddress,
			value: CIRCLE_PERMIT_AMOUNT,
			nonce: permitMetadata.nonce,
			deadline: maxUint256,
		},
	};

	const rawPermitSignature = await account.signTypedData(typedData);
	const verified = await publicClient.verifyTypedData({
		address: parameters.sender,
		...typedData,
		signature: rawPermitSignature,
	});
	if (!verified) {
		throw new Error("Circle permit signature verification failed");
	}

	const { signature } = parseErc6492Signature(rawPermitSignature);

	return {
		paymaster: paymasterAddress,
		paymasterData: encodePacked(
			["uint8", "address", "uint256", "bytes"],
			[0, permitMetadata.usdcAddress, CIRCLE_PERMIT_AMOUNT, signature],
		),
		paymasterPostOpGasLimit: CIRCLE_PAYMASTER_POST_OP_GAS_LIMIT,
		paymasterVerificationGasLimit: CIRCLE_PAYMASTER_VERIFICATION_GAS_LIMIT,
		...(parameters.isFinal ? { isFinal: true } : {}),
	};
}

async function resolveExecutionContext(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
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
	const owner = privateKeyToAccount(config.privateKey);
	const publicClient = buildPublicClient(chainConfig);
	const walletClient = buildWalletClient(config.privateKey, chainConfig);
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

	const paymasterProvider = pinnedPreview?.paymasterProvider ?? requestedPaymasterProvider(config);
	const providerConfig = requireProvider
		? pinnedPreview?.paymasterProvider
			? await preflightProvider(chainConfig, paymasterProvider)
			: await resolveAaProvider(chainConfig, paymasterProvider, warnings)
		: previewProviderConfig(chainConfig, paymasterProvider);

	if (!providerConfig && requireProvider) {
		throw new Error(`No zero-config paymaster is available on ${chainConfig.name}`);
	}

	if (!providerConfig && !requireProvider) {
		warnings.push(
			`${paymasterProvider} is not available as a zero-config paymaster on ${chainConfig.name}`,
		);
	}

	const account = await toSimple7702SmartAccount({
		client: publicClient,
		owner,
		entryPoint: ENTRY_POINT.version,
	});

	return {
		...baseContext,
		mode,
		account,
		entryPoint: ENTRY_POINT,
		paymasterProvider: providerConfig?.provider ?? paymasterProvider,
		providerConfig,
	};
}

export async function getExecutionPreview(
	config: TrustedAgentsConfig,
	chainConfig: ChainConfig,
	{ requireProvider = false }: { requireProvider?: boolean } = {},
): Promise<ExecutionPreview> {
	const context = await resolveExecutionContext(config, chainConfig, { requireProvider });
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
	{
		preview,
	}: { preview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode"> } = {},
): Promise<void> {
	const context = await resolveExecutionContext(config, chainConfig, {
		pinnedPreview: preview,
		requireProvider: true,
	});

	if (context.mode !== "eip7702" || context.providerConfig?.provider !== "circle") {
		return;
	}

	const permitMetadata = await loadCirclePermitMetadata(
		context.publicClient,
		chainConfig,
		context.executionAddress,
	);
	cacheCirclePermitMetadata(chainConfig.caip2, context.executionAddress, permitMetadata);
}

async function executeEoaCalls(
	context: EoaExecutionContext,
	calls: Array<{ to: Address; data: Hex; value?: bigint }>,
): Promise<ExecutionSendResult> {
	let transactionHash: Hex | undefined;
	let transactionReceipt: TransactionReceipt | undefined;

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
	}

	if (!transactionHash || !transactionReceipt) {
		throw new Error("No transaction was sent");
	}
	if (transactionReceipt.status === "reverted") {
		throw new Error(
			`Transaction ${transactionHash} reverted on ${context.walletClient.chain?.name ?? "this chain"}`,
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
		gasPaymentMode: "native",
		transactionReceipt,
		transactionHash,
	};
}

async function executeAaCalls(
	context: AaExecutionContext,
	chainConfig: ChainConfig,
	calls: Array<{ to: Address; data: Hex; value?: bigint }>,
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
	let circlePermitMetadataPromise: Promise<CirclePermitMetadata> | undefined;
	function getCirclePermitMetadata(sender: Address): Promise<CirclePermitMetadata> {
		if (!circlePermitMetadataPromise) {
			const cached = takeCachedCirclePermitMetadata(chainConfig.caip2, sender);
			circlePermitMetadataPromise = cached
				? Promise.resolve(cached)
				: loadCirclePermitMetadata(context.publicClient, chainConfig, sender);
		}

		return circlePermitMetadataPromise;
	}

	const paymaster =
		providerConfig.provider === "circle"
			? (() => {
					const circlePaymasterHandler = async (parameters: {
						sender: Address;
						maxFeePerGas?: bigint;
						callGasLimit?: bigint;
						verificationGasLimit?: bigint;
						preVerificationGas?: bigint;
						paymasterVerificationGasLimit?: bigint;
						paymasterPostOpGasLimit?: bigint;
					}) =>
						buildCirclePaymasterResponse(
							context.account,
							context.publicClient,
							chainConfig,
							providerConfig.paymasterAddress!,
							await getCirclePermitMetadata(parameters.sender),
							parameters,
						);

					return {
						getPaymasterStubData: circlePaymasterHandler,
						getPaymasterData: circlePaymasterHandler,
					};
				})()
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
	calls: Array<{ to: Address; data: Hex; value?: bigint }>,
	{
		preview,
	}: { preview?: Pick<ExecutionPreview, "mode" | "paymasterProvider" | "requestedMode"> } = {},
): Promise<ExecutionSendResult> {
	const context = await resolveExecutionContext(config, chainConfig, {
		pinnedPreview: preview,
		requireProvider: true,
	});

	if (context.mode === "eoa") {
		return executeEoaCalls(context, calls);
	}

	return executeAaCalls(context, chainConfig, calls);
}
