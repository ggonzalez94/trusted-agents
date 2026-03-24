import type { ChainConfig, ExecutionPaymasterProvider } from "../../config/types.js";
import { getCatalogProviderConfig } from "./catalog.js";
import { assertBundlerSupportsEntryPoint, resolveSupportedToken } from "./rpc.js";
import { getServoCapabilities } from "./servo.js";
import type { AaProviderConfig, ServoCapabilities } from "./types.js";

export function previewProviderConfig(
	chainConfig: ChainConfig,
	provider: ExecutionPaymasterProvider,
): AaProviderConfig | undefined {
	return getCatalogProviderConfig(chainConfig.caip2, provider);
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

async function preflightCircleProvider(chainConfig: ChainConfig): Promise<AaProviderConfig> {
	const config = getCatalogProviderConfig(chainConfig.caip2, "circle");
	if (!config?.paymasterAddress) {
		throw new Error(
			`Circle Paymaster is not available as a zero-config option on ${chainConfig.name}`,
		);
	}

	await assertBundlerSupportsEntryPoint(config.bundlerUrl, config.entryPoint);
	return config;
}

async function preflightCandideProvider(chainConfig: ChainConfig): Promise<AaProviderConfig> {
	const config = getCatalogProviderConfig(chainConfig.caip2, "candide");
	if (!config?.paymasterUrl) {
		throw new Error(
			`Candide is not available as a zero-config USDC paymaster on ${chainConfig.name}`,
		);
	}

	await assertBundlerSupportsEntryPoint(config.bundlerUrl, config.entryPoint);
	const tokenSupport = await resolveSupportedToken(
		config.paymasterUrl,
		config.entryPoint.address,
		chainConfig.caip2,
	);
	if (!tokenSupport) {
		throw new Error(`Candide does not advertise USDC gas payment on ${chainConfig.name}`);
	}

	return {
		...config,
		paymasterAddress: tokenSupport.paymasterAddress,
	};
}

async function preflightServoProvider(chainConfig: ChainConfig): Promise<AaProviderConfig> {
	const config = getCatalogProviderConfig(chainConfig.caip2, "servo");
	if (!config?.paymasterUrl) {
		throw new Error(
			`Servo is not available as a zero-config USDC paymaster on ${chainConfig.name}`,
		);
	}

	await assertBundlerSupportsEntryPoint(config.bundlerUrl, config.entryPoint);

	let accountFactoryAddress = config.accountFactoryAddress;
	let capabilities: ServoCapabilities | undefined;
	try {
		capabilities = await getServoCapabilities(config.paymasterUrl);
	} catch (error) {
		if (!accountFactoryAddress) {
			throw error;
		}
	}

	if (
		capabilities?.supportedChains?.length &&
		!capabilities.supportedChains.some((item) => item.chainId === chainConfig.chainId)
	) {
		throw new Error(`Servo endpoint does not advertise ${chainConfig.name}`);
	}

	if (capabilities?.accountFactoryAddress) {
		accountFactoryAddress = capabilities.accountFactoryAddress;
	}

	if (!accountFactoryAddress) {
		throw new Error(`Servo account factory is not configured for ${chainConfig.name}`);
	}

	return {
		...config,
		accountFactoryAddress,
	};
}

export async function preflightProvider(
	chainConfig: ChainConfig,
	provider: ExecutionPaymasterProvider,
): Promise<AaProviderConfig> {
	if (provider === "circle") {
		return preflightCircleProvider(chainConfig);
	}

	if (provider === "servo") {
		return preflightServoProvider(chainConfig);
	}

	return preflightCandideProvider(chainConfig);
}

export async function resolveAaProvider(
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
