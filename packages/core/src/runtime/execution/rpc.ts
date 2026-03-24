import type { Address } from "viem";
import { getAddress } from "viem";
import { getUsdcAsset } from "../assets.js";
import type {
	EntryPointConfig,
	SupportedErc20Token,
	SupportedErc20TokensResponse,
} from "./types.js";

export async function rpcRequest<TResult>(
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

export async function assertBundlerSupportsEntryPoint(
	bundlerUrl: string,
	entryPoint: EntryPointConfig,
): Promise<void> {
	const supported = await rpcRequest<string[]>(bundlerUrl, "eth_supportedEntryPoints", []);
	if (!supported.some((address) => address.toLowerCase() === entryPoint.address.toLowerCase())) {
		throw new Error(`Bundler does not expose EntryPoint ${entryPoint.version}`);
	}
}

export async function resolveSupportedToken(
	paymasterUrl: string,
	entryPointAddress: Address,
	chain: string,
): Promise<{ token: SupportedErc20Token; paymasterAddress?: Address } | null> {
	const usdc = getUsdcAsset(chain);
	if (!usdc) {
		return null;
	}

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
