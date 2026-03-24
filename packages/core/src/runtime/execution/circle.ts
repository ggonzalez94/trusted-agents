import type { Address, Hex } from "viem";
import { encodePacked, maxUint256, parseErc6492Signature } from "viem";
import type { ChainConfig } from "../../config/types.js";
import { getUsdcAsset } from "../assets.js";
import { ERC20_NAME_ABI, ERC20_NONCES_ABI, ERC20_VERSION_ABI } from "./abis.js";
import {
	CIRCLE_PAYMASTER_POST_OP_GAS_LIMIT,
	CIRCLE_PAYMASTER_VERIFICATION_GAS_LIMIT,
	CIRCLE_PERMIT_AMOUNT,
} from "./catalog.js";
import type { CirclePermitMetadata, Eip7702ExecutionContext } from "./types.js";

const CIRCLE_PERMIT_METADATA_CACHE = new Map<string, CirclePermitMetadata>();

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

async function loadCirclePermitMetadata(
	context: Eip7702ExecutionContext,
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
			context.publicClient.readContract({
				address: usdc.address,
				abi: ERC20_NAME_ABI,
				functionName: "name",
			}),
			context.publicClient.readContract({
				address: usdc.address,
				abi: ERC20_VERSION_ABI,
				functionName: "version",
			}),
			context.publicClient.readContract({
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
	context: Eip7702ExecutionContext,
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

	const rawPermitSignature = await context.account.signTypedData(typedData);
	const verified = await context.publicClient.verifyTypedData({
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

export async function warmCirclePermitMetadata(
	context: Eip7702ExecutionContext,
	chainConfig: ChainConfig,
): Promise<void> {
	const permitMetadata = await loadCirclePermitMetadata(
		context,
		chainConfig,
		context.executionAddress,
	);
	cacheCirclePermitMetadata(chainConfig.caip2, context.executionAddress, permitMetadata);
}

export function createCirclePaymaster(
	context: Eip7702ExecutionContext,
	chainConfig: ChainConfig,
	paymasterAddress: Address,
): {
	getPaymasterStubData: (parameters: {
		sender: Address;
		maxFeePerGas?: bigint;
		callGasLimit?: bigint;
		verificationGasLimit?: bigint;
		preVerificationGas?: bigint;
		paymasterVerificationGasLimit?: bigint;
		paymasterPostOpGasLimit?: bigint;
	}) => Promise<{
		paymaster: Address;
		paymasterData: Hex;
		paymasterPostOpGasLimit: bigint;
		paymasterVerificationGasLimit: bigint;
		isFinal?: boolean;
	}>;
	getPaymasterData: (parameters: {
		sender: Address;
		maxFeePerGas?: bigint;
		callGasLimit?: bigint;
		verificationGasLimit?: bigint;
		preVerificationGas?: bigint;
		paymasterVerificationGasLimit?: bigint;
		paymasterPostOpGasLimit?: bigint;
	}) => Promise<{
		paymaster: Address;
		paymasterData: Hex;
		paymasterPostOpGasLimit: bigint;
		paymasterVerificationGasLimit: bigint;
		isFinal?: boolean;
	}>;
} {
	let circlePermitMetadataPromise: Promise<CirclePermitMetadata> | undefined;

	const getCirclePermitMetadata = async (sender: Address): Promise<CirclePermitMetadata> => {
		if (!circlePermitMetadataPromise) {
			const cached = takeCachedCirclePermitMetadata(chainConfig.caip2, sender);
			circlePermitMetadataPromise = cached
				? Promise.resolve(cached)
				: loadCirclePermitMetadata(context, chainConfig, sender);
		}

		return circlePermitMetadataPromise;
	};

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
			context,
			chainConfig,
			paymasterAddress,
			await getCirclePermitMetadata(parameters.sender),
			parameters,
		);

	return {
		getPaymasterStubData: circlePaymasterHandler,
		getPaymasterData: circlePaymasterHandler,
	};
}
