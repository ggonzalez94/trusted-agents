import type { Hex } from "viem";
import { entryPoint07Address, entryPoint08Address } from "viem/account-abstraction";
import type { ExecutionPaymasterProvider } from "../../config/types.js";
import type { AaProviderConfig, EntryPointConfig } from "./types.js";

export const ENTRY_POINT_08 = {
	address: entryPoint08Address,
	version: "0.8",
} as const satisfies EntryPointConfig;

export const ENTRY_POINT_07 = {
	address: entryPoint07Address,
	version: "0.7",
} as const satisfies EntryPointConfig;

type ProviderCatalogEntry = Omit<AaProviderConfig, "provider">;

const ZERO_CONFIG_PROVIDER_CATALOG: Record<
	ExecutionPaymasterProvider,
	Partial<Record<string, ProviderCatalogEntry>>
> = {
	circle: {
		"eip155:8453": {
			bundlerUrl: "https://public.pimlico.io/v2/8453/rpc",
			paymasterAddress: "0x0578cFB241215b77442a541325d6A4E6dFE700Ec",
			entryPoint: ENTRY_POINT_08,
		},
		"eip155:84532": {
			bundlerUrl: "https://public.pimlico.io/v2/84532/rpc",
			paymasterAddress: "0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966",
			entryPoint: ENTRY_POINT_08,
		},
	},
	candide: {
		"eip155:8453": {
			bundlerUrl: "https://api.candide.dev/public/v3/8453",
			paymasterUrl: "https://api.candide.dev/public/v3/8453",
			entryPoint: ENTRY_POINT_08,
		},
	},
	servo: {
		"eip155:167000": {
			bundlerUrl: "https://api-production-cdfe.up.railway.app/rpc",
			paymasterUrl: "https://api-production-cdfe.up.railway.app/rpc",
			accountFactoryAddress: "0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716",
			entryPoint: ENTRY_POINT_07,
		},
	},
};

export function getCatalogProviderConfig(
	chain: string,
	provider: ExecutionPaymasterProvider,
): AaProviderConfig | undefined {
	const config = ZERO_CONFIG_PROVIDER_CATALOG[provider][chain];
	if (!config) {
		return undefined;
	}

	return {
		provider,
		...config,
	};
}

export const CIRCLE_PAYMASTER_VERIFICATION_GAS_LIMIT = 200_000n;
export const CIRCLE_PAYMASTER_POST_OP_GAS_LIMIT = 15_000n;
export const CIRCLE_PERMIT_AMOUNT = 10_000_000n;
export const CANDIDE_ALLOWANCE_BUFFER = 1_000_000n;
export const SERVO_ACCOUNT_SALT = 0n;
export const SERVO_DUMMY_SIGNATURE = `0x${"00".repeat(65)}` as Hex;

export const USDC_PERMIT_TYPES = {
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
