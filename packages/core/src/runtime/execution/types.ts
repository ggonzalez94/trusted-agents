import type { Address, Hex, TransactionReceipt } from "viem";
import type { toSimple7702SmartAccount } from "viem/account-abstraction";
import type {
	buildChainPublicClient as buildPublicClient,
	buildChainWalletClient as buildWalletClient,
} from "../../common/index.js";
import type {
	ExecutionMode,
	ExecutionPaymasterProvider,
	TrustedAgentsAccount,
} from "../../config/types.js";

export type EntryPointVersion = "0.7" | "0.8";
export type GasPaymentMode = "erc20-usdc" | "native";
export type ResolvedExecutionMode = "eoa" | "eip4337" | "eip7702";

export interface EntryPointConfig {
	address: Address;
	version: EntryPointVersion;
}

export interface SupportedErc20Token {
	address: Address;
	decimals?: string;
	symbol?: string;
}

export interface SupportedErc20TokensResponse {
	paymasterMetadata?: {
		address?: Address;
	};
	tokens?: SupportedErc20Token[];
}

export interface CirclePermitMetadata {
	usdcAddress: Address;
	name: string;
	version: string;
	nonce: bigint;
}

export interface ServoGasPriceGuidance {
	baseFeePerGas?: Hex;
	suggestedMaxFeePerGas?: Hex;
	suggestedMaxPriorityFeePerGas?: Hex;
}

export interface ServoCapabilities {
	accountFactoryAddress?: Address;
	supportedChains?: Array<{ chainId?: number }>;
	gasPriceGuidance?: ServoGasPriceGuidance;
}

export interface ServoQuoteResponse {
	paymaster: Address;
	paymasterData: Hex;
	paymasterAndData: Hex;
	callGasLimit: Hex;
	verificationGasLimit: Hex;
	preVerificationGas: Hex;
	paymasterVerificationGasLimit: Hex;
	paymasterPostOpGasLimit: Hex;
	tokenAddress: Address;
	maxTokenCostMicros: string;
	validUntil: number;
}

export interface AaProviderConfig {
	provider: ExecutionPaymasterProvider;
	bundlerUrl: string;
	paymasterUrl?: string;
	paymasterAddress?: Address;
	entryPoint: EntryPointConfig;
	accountFactoryAddress?: Address;
}

export interface ExecutionCall {
	to: Address;
	data?: Hex;
	value?: bigint;
}

export interface ExecutionPreview {
	requestedMode: ExecutionMode;
	mode: ResolvedExecutionMode;
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

export interface ExecutionEvmSigner {
	address: Address;
	signTypedData(parameters: {
		domain: Record<string, unknown>;
		types: Record<string, unknown>;
		primaryType: string;
		message: Record<string, unknown>;
	}): Promise<Hex>;
	readContract(args: {
		address: Address;
		abi: readonly unknown[];
		functionName: string;
		args?: readonly unknown[];
	}): Promise<unknown>;
}

export interface BaseExecutionContext {
	requestedMode: ExecutionMode;
	mode: ResolvedExecutionMode;
	messagingAddress: Address;
	executionAddress: Address;
	fundingAddress: Address;
	paymasterProvider?: ExecutionPaymasterProvider;
	warnings: string[];
	publicClient: ReturnType<typeof buildPublicClient>;
	walletClient: ReturnType<typeof buildWalletClient>;
	owner: TrustedAgentsAccount;
}

export interface EoaExecutionContext extends BaseExecutionContext {
	mode: "eoa";
}

export interface Eip7702ExecutionContext extends BaseExecutionContext {
	mode: "eip7702";
	account: Awaited<ReturnType<typeof toSimple7702SmartAccount>>;
	entryPoint: EntryPointConfig;
	providerConfig?: AaProviderConfig;
}

export interface Eip4337ExecutionContext extends BaseExecutionContext {
	mode: "eip4337";
	entryPoint: EntryPointConfig;
	providerConfig?: AaProviderConfig;
}

export type AaExecutionContext = Eip7702ExecutionContext | Eip4337ExecutionContext;
export type ResolvedExecutionContext = EoaExecutionContext | AaExecutionContext;
