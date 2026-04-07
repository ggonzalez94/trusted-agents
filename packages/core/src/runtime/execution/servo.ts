import type { Address, Hex } from "viem";
import {
	http,
	decodeFunctionData,
	encodeFunctionData,
	erc20Abi,
	formatUnits,
	getAddress,
	serializeErc6492Signature,
	toHex,
} from "viem";
import { createBundlerClient, getUserOperationHash } from "viem/account-abstraction";
import { ValidationError } from "../../common/index.js";
import type { ChainConfig } from "../../config/types.js";
import { getUsdcAsset } from "../assets.js";
import {
	ENTRY_POINT_NONCE_ABI,
	ERC20_NAME_ABI,
	ERC20_NONCES_ABI,
	ERC20_VERSION_ABI,
	SERVO_ACCOUNT_ABI,
	SERVO_ACCOUNT_FACTORY_ABI,
} from "./abis.js";
import { SERVO_ACCOUNT_SALT, SERVO_DUMMY_SIGNATURE, USDC_PERMIT_TYPES } from "./catalog.js";
import { rpcRequest } from "./rpc.js";
import type {
	Eip4337ExecutionContext,
	ExecutionCall,
	ExecutionEvmSigner,
	ExecutionSendResult,
	ServoCapabilities,
	ServoGasPriceGuidance,
	ServoQuoteResponse,
} from "./types.js";

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function asHex(value: unknown, label: string): Hex {
	if (typeof value !== "string" || !value.startsWith("0x")) {
		throw new Error(`${label} must be a hex string`);
	}
	return value as Hex;
}

function asOptionalHex(value: unknown, label: string): Hex | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	return asHex(value, label);
}

function asAddress(value: unknown, label: string): Address {
	if (typeof value !== "string") {
		throw new Error(`${label} must be an address`);
	}
	return getAddress(value);
}

function asDecimalString(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^\d+$/u.test(value)) {
		throw new Error(`${label} must be a decimal string`);
	}
	return value;
}

function asNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a number`);
	}
	return value;
}

function parseServoQuote(value: unknown): ServoQuoteResponse {
	const payload = asRecord(value, "Servo paymaster quote");
	return {
		paymaster: asAddress(payload.paymaster, "paymaster"),
		paymasterData: asHex(payload.paymasterData, "paymasterData"),
		paymasterAndData: asHex(payload.paymasterAndData, "paymasterAndData"),
		callGasLimit: asHex(payload.callGasLimit, "callGasLimit"),
		verificationGasLimit: asHex(payload.verificationGasLimit, "verificationGasLimit"),
		preVerificationGas: asHex(payload.preVerificationGas, "preVerificationGas"),
		paymasterVerificationGasLimit: asHex(
			payload.paymasterVerificationGasLimit,
			"paymasterVerificationGasLimit",
		),
		paymasterPostOpGasLimit: asHex(payload.paymasterPostOpGasLimit, "paymasterPostOpGasLimit"),
		tokenAddress: asAddress(payload.tokenAddress, "tokenAddress"),
		maxTokenCostMicros: asDecimalString(payload.maxTokenCostMicros, "maxTokenCostMicros"),
		validUntil: asNumber(payload.validUntil, "validUntil"),
	};
}

function parseServoCapabilities(value: unknown): ServoCapabilities {
	const payload = asRecord(value, "Servo capabilities");
	const supportedChains = Array.isArray(payload.supportedChains)
		? payload.supportedChains.map((item, index) => {
				const chain = asRecord(item, `supportedChains[${index}]`);
				return {
					chainId:
						chain.chainId === undefined || chain.chainId === null
							? undefined
							: asNumber(chain.chainId, `supportedChains[${index}].chainId`),
				};
			})
		: undefined;
	const gasPriceGuidance =
		payload.gasPriceGuidance === undefined || payload.gasPriceGuidance === null
			? undefined
			: (() => {
					const guidance = asRecord(payload.gasPriceGuidance, "gasPriceGuidance");
					return {
						baseFeePerGas: asOptionalHex(guidance.baseFeePerGas, "gasPriceGuidance.baseFeePerGas"),
						suggestedMaxFeePerGas: asOptionalHex(
							guidance.suggestedMaxFeePerGas,
							"gasPriceGuidance.suggestedMaxFeePerGas",
						),
						suggestedMaxPriorityFeePerGas: asOptionalHex(
							guidance.suggestedMaxPriorityFeePerGas,
							"gasPriceGuidance.suggestedMaxPriorityFeePerGas",
						),
					} satisfies ServoGasPriceGuidance;
				})();

	return {
		accountFactoryAddress:
			payload.accountFactoryAddress === undefined || payload.accountFactoryAddress === null
				? undefined
				: asAddress(payload.accountFactoryAddress, "accountFactoryAddress"),
		supportedChains,
		gasPriceGuidance,
	};
}

function buildServoFactoryData(owner: Address): Hex {
	return encodeFunctionData({
		abi: SERVO_ACCOUNT_FACTORY_ABI,
		functionName: "createAccount",
		args: [owner, SERVO_ACCOUNT_SALT],
	});
}

function buildServoCallData(calls: ExecutionCall[]): Hex {
	if (calls.length === 1) {
		const single = calls[0]!;
		return encodeFunctionData({
			abi: SERVO_ACCOUNT_ABI,
			functionName: "execute",
			args: [single.to, single.value ?? 0n, single.data ?? "0x"],
		});
	}

	return encodeFunctionData({
		abi: SERVO_ACCOUNT_ABI,
		functionName: "executeBatch",
		args: [
			calls.map((call) => call.to),
			calls.map((call) => call.value ?? 0n),
			calls.map((call) => call.data ?? "0x"),
		],
	});
}

function sumOutgoingErc20TransferAmount(calls: ExecutionCall[], tokenAddress: Address): bigint {
	let total = 0n;
	for (const call of calls) {
		if (call.to.toLowerCase() !== tokenAddress.toLowerCase()) {
			continue;
		}

		const data = call.data ?? "0x";
		if (!data.startsWith(ERC20_TRANSFER_SELECTOR)) {
			continue;
		}

		try {
			const decoded = decodeFunctionData({
				abi: erc20Abi,
				data,
			});
			if (decoded.functionName !== "transfer") {
				continue;
			}

			const amount = decoded.args[1];
			if (typeof amount === "bigint") {
				total += amount;
			}
		} catch {}
	}

	return total;
}

export async function assertServoTokenSpendFitsBalance(
	context: Eip4337ExecutionContext,
	chainConfig: ChainConfig,
	calls: ExecutionCall[],
	stubQuote: ServoQuoteResponse,
): Promise<void> {
	const usdc = getUsdcAsset(chainConfig.caip2);
	if (!usdc || usdc.address.toLowerCase() !== stubQuote.tokenAddress.toLowerCase()) {
		return;
	}

	const outgoingAmount = sumOutgoingErc20TransferAmount(calls, stubQuote.tokenAddress);
	const reservedFee = BigInt(stubQuote.maxTokenCostMicros);
	const totalNeeded = outgoingAmount + reservedFee;
	if (totalNeeded === 0n) {
		return;
	}

	const balance = (await context.publicClient.readContract({
		address: stubQuote.tokenAddress,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [context.executionAddress],
	})) as bigint;
	if (balance >= totalNeeded) {
		return;
	}

	if (outgoingAmount === 0n) {
		throw new ValidationError(
			`Insufficient USDC to pay the Servo paymaster fee on ${chainConfig.name}: ` +
				`estimated fee ${formatUnits(reservedFee, usdc.decimals)} USDC, ` +
				`current balance ${formatUnits(balance, usdc.decimals)} USDC. ` +
				`Fund ${context.executionAddress} with at least ${formatUnits(reservedFee, usdc.decimals)} USDC on ${chainConfig.name}.`,
		);
	}

	const maxTransferable = balance > reservedFee ? balance - reservedFee : 0n;
	throw new ValidationError(
		`Insufficient USDC balance for transfer on ${chainConfig.name}: requested ${formatUnits(
			outgoingAmount,
			usdc.decimals,
		)} USDC, estimated max paymaster fee ${formatUnits(
			reservedFee,
			usdc.decimals,
		)} USDC, current balance ${formatUnits(balance, usdc.decimals)} USDC. Reduce the transfer to ${formatUnits(
			maxTransferable,
			usdc.decimals,
		)} USDC or less.`,
	);
}

export async function resolveServoExecutionAddress(
	context: Pick<Eip4337ExecutionContext, "publicClient">["publicClient"],
	factoryAddress: Address,
	owner: Address,
): Promise<Address> {
	const result = await context.readContract({
		address: factoryAddress,
		abi: SERVO_ACCOUNT_FACTORY_ABI,
		functionName: "getAddress",
		args: [owner, SERVO_ACCOUNT_SALT],
	});
	return getAddress(result);
}

async function resolveEip1559Fees(
	context: Pick<Eip4337ExecutionContext, "publicClient">["publicClient"],
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
	try {
		const fees = await context.estimateFeesPerGas();
		if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
			return {
				maxFeePerGas: fees.maxFeePerGas,
				maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
			};
		}
	} catch {
		// Fall back to gas price below.
	}

	const gasPrice = await context.getGasPrice();
	const maxPriorityFeePerGas = gasPrice / 10n > 0n ? gasPrice / 10n : 1n;
	return {
		maxFeePerGas: gasPrice >= maxPriorityFeePerGas ? gasPrice : maxPriorityFeePerGas,
		maxPriorityFeePerGas,
	};
}

export async function getServoCapabilities(endpoint: string): Promise<ServoCapabilities> {
	return parseServoCapabilities(await rpcRequest<unknown>(endpoint, "pm_getCapabilities", []));
}

async function resolveServoEip1559Fees(
	context: Pick<Eip4337ExecutionContext, "publicClient">["publicClient"],
	endpoint: string,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
	try {
		const guidance = (await getServoCapabilities(endpoint)).gasPriceGuidance;
		if (guidance?.suggestedMaxFeePerGas && guidance.suggestedMaxPriorityFeePerGas) {
			return {
				maxFeePerGas: BigInt(guidance.suggestedMaxFeePerGas),
				maxPriorityFeePerGas: BigInt(guidance.suggestedMaxPriorityFeePerGas),
			};
		}
	} catch {
		// Fall back to the chain RPC fee estimate below.
	}

	return resolveEip1559Fees(context);
}

function buildServoSendUserOperation(parameters: {
	sender: Address;
	nonce: bigint;
	factory?: Address;
	factoryData?: Hex;
	callData: Hex;
	callGasLimit: Hex;
	verificationGasLimit: Hex;
	preVerificationGas: Hex;
	maxFeePerGas: bigint;
	maxPriorityFeePerGas: bigint;
	paymasterAndData: Hex;
	signature: Hex;
}): Record<string, Hex | Address> {
	return {
		sender: parameters.sender,
		nonce: toHex(parameters.nonce),
		...(parameters.factory ? { factory: parameters.factory } : {}),
		...(parameters.factoryData ? { factoryData: parameters.factoryData } : {}),
		callData: parameters.callData,
		callGasLimit: parameters.callGasLimit,
		verificationGasLimit: parameters.verificationGasLimit,
		preVerificationGas: parameters.preVerificationGas,
		maxFeePerGas: toHex(parameters.maxFeePerGas),
		maxPriorityFeePerGas: toHex(parameters.maxPriorityFeePerGas),
		paymasterAndData: parameters.paymasterAndData,
		signature: parameters.signature,
	};
}

export function createServoExecutionEvmSigner(
	context: Eip4337ExecutionContext,
	chainConfig: ChainConfig,
): ExecutionEvmSigner {
	let isDeployedPromise: Promise<boolean> | undefined;
	const isDeployed = async () => {
		if (!isDeployedPromise) {
			isDeployedPromise = context.publicClient
				.getCode({ address: context.executionAddress })
				.then((code) => Boolean(code && code !== "0x"));
		}

		return await isDeployedPromise;
	};

	return {
		address: context.executionAddress,
		signTypedData: async (parameters) => {
			const signature = await context.owner.signTypedData(parameters as never);
			if (await isDeployed()) {
				return signature;
			}

			const factoryAddress = context.providerConfig?.accountFactoryAddress;
			if (!factoryAddress) {
				throw new Error(`No Servo account factory is configured for ${chainConfig.name}`);
			}

			return serializeErc6492Signature({
				address: factoryAddress,
				data: buildServoFactoryData(context.owner.address),
				signature,
			});
		},
		readContract: async (args) =>
			(await context.publicClient.readContract(args as never)) as unknown,
	};
}

export async function executeServoEip4337Calls(
	context: Eip4337ExecutionContext,
	chainConfig: ChainConfig,
	calls: ExecutionCall[],
): Promise<ExecutionSendResult> {
	const providerConfig = context.providerConfig;
	if (!providerConfig || providerConfig.provider !== "servo") {
		throw new Error(`No Servo paymaster provider is configured for ${chainConfig.name}`);
	}
	if (!providerConfig.accountFactoryAddress) {
		throw new Error(`No Servo account factory is configured for ${chainConfig.name}`);
	}

	const bundlerClient = createBundlerClient({
		client: context.publicClient,
		transport: http(providerConfig.bundlerUrl),
	});
	const paymasterEndpoint = providerConfig.paymasterUrl ?? providerConfig.bundlerUrl;

	const nonce = (await context.publicClient.readContract({
		address: context.entryPoint.address,
		abi: ENTRY_POINT_NONCE_ABI,
		functionName: "getNonce",
		args: [context.executionAddress, 0n],
	})) as bigint;

	const { maxFeePerGas, maxPriorityFeePerGas } = await resolveServoEip1559Fees(
		context.publicClient,
		paymasterEndpoint,
	);
	const accountCode = await context.publicClient.getCode({
		address: context.executionAddress,
	});
	const deploymentFields =
		accountCode && accountCode !== "0x"
			? {}
			: {
					factory: providerConfig.accountFactoryAddress,
					factoryData: buildServoFactoryData(context.owner.address),
				};
	const callData = buildServoCallData(calls);

	const draftUserOperation = {
		sender: context.executionAddress,
		nonce: toHex(nonce),
		...deploymentFields,
		callData,
		maxFeePerGas: toHex(maxFeePerGas),
		maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
		signature: SERVO_DUMMY_SIGNATURE,
	};
	const chainIdHex = toHex(chainConfig.chainId);

	const stubQuote = parseServoQuote(
		await rpcRequest<unknown>(paymasterEndpoint, "pm_getPaymasterStubData", [
			draftUserOperation,
			context.entryPoint.address,
			chainIdHex,
			{},
		]),
	);
	await assertServoTokenSpendFitsBalance(context, chainConfig, calls, stubQuote);

	const quotedUserOperation = {
		...draftUserOperation,
		callGasLimit: stubQuote.callGasLimit,
		verificationGasLimit: stubQuote.verificationGasLimit,
		preVerificationGas: stubQuote.preVerificationGas,
	};

	const [permitNonce, tokenName, tokenVersion] = await Promise.all([
		context.publicClient.readContract({
			address: stubQuote.tokenAddress,
			abi: ERC20_NONCES_ABI,
			functionName: "nonces",
			args: [context.executionAddress],
		}) as Promise<bigint>,
		context.publicClient
			.readContract({ address: stubQuote.tokenAddress, abi: ERC20_NAME_ABI, functionName: "name" })
			.catch(() => "USD Coin" as string),
		context.publicClient
			.readContract({
				address: stubQuote.tokenAddress,
				abi: ERC20_VERSION_ABI,
				functionName: "version",
			})
			.catch(() => "2" as string),
	]);

	const permitValue = BigInt(stubQuote.maxTokenCostMicros);
	const permitDeadline = BigInt(stubQuote.validUntil);
	const permitSignature = await context.owner.signTypedData({
		domain: {
			name: tokenName,
			version: tokenVersion,
			chainId: BigInt(chainConfig.chainId),
			verifyingContract: stubQuote.tokenAddress,
		},
		types: USDC_PERMIT_TYPES,
		primaryType: "Permit",
		message: {
			owner: context.executionAddress,
			spender: stubQuote.paymaster,
			value: permitValue,
			nonce: permitNonce,
			deadline: permitDeadline,
		},
	});

	const finalQuote = parseServoQuote(
		await rpcRequest<unknown>(paymasterEndpoint, "pm_getPaymasterData", [
			quotedUserOperation,
			context.entryPoint.address,
			chainIdHex,
			{
				permit: {
					value: permitValue.toString(),
					deadline: permitDeadline.toString(),
					signature: permitSignature,
				},
			},
		]),
	);

	const userOperationHashForSignature = getUserOperationHash({
		userOperation: {
			sender: context.executionAddress,
			nonce,
			...deploymentFields,
			callData,
			callGasLimit: BigInt(finalQuote.callGasLimit),
			verificationGasLimit: BigInt(finalQuote.verificationGasLimit),
			preVerificationGas: BigInt(finalQuote.preVerificationGas),
			maxFeePerGas,
			maxPriorityFeePerGas,
			paymaster: finalQuote.paymaster,
			paymasterData: finalQuote.paymasterData,
			paymasterVerificationGasLimit: BigInt(finalQuote.paymasterVerificationGasLimit),
			paymasterPostOpGasLimit: BigInt(finalQuote.paymasterPostOpGasLimit),
			signature: SERVO_DUMMY_SIGNATURE,
		},
		entryPointAddress: context.entryPoint.address,
		entryPointVersion: context.entryPoint.version,
		chainId: chainConfig.chainId,
	});
	const userOperationSignature = await context.owner.signMessage({
		message: { raw: userOperationHashForSignature },
	});

	const sentUserOperationHash = await rpcRequest<Hex>(
		providerConfig.bundlerUrl,
		"eth_sendUserOperation",
		[
			buildServoSendUserOperation({
				sender: context.executionAddress,
				nonce,
				...deploymentFields,
				callData,
				callGasLimit: finalQuote.callGasLimit,
				verificationGasLimit: finalQuote.verificationGasLimit,
				preVerificationGas: finalQuote.preVerificationGas,
				maxFeePerGas,
				maxPriorityFeePerGas,
				paymasterAndData: finalQuote.paymasterAndData,
				signature: userOperationSignature,
			}),
			context.entryPoint.address,
		],
	);

	const userOperationReceipt = await bundlerClient.waitForUserOperationReceipt({
		hash: sentUserOperationHash,
	});
	if (userOperationReceipt.receipt.status === "reverted") {
		throw new Error(
			`User operation ${sentUserOperationHash} reverted in transaction ${userOperationReceipt.receipt.transactionHash}`,
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
		paymasterAddress: finalQuote.paymaster,
		transactionReceipt: userOperationReceipt.receipt,
		transactionHash: userOperationReceipt.receipt.transactionHash,
		userOperationHash: sentUserOperationHash,
	};
}

export async function deployServoExecutionAccountIfNeeded(
	context: Eip4337ExecutionContext,
	chainConfig: ChainConfig,
): Promise<void> {
	const code = await context.publicClient.getCode({
		address: context.executionAddress,
	});
	if (code && code !== "0x") {
		return;
	}

	await executeServoEip4337Calls(context, chainConfig, [
		{
			to: context.owner.address,
			value: 0n,
			data: "0x",
		},
	]);
}
