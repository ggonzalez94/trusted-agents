import type { LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import type { SigningProvider } from "./provider.js";

export async function createSigningProviderViemAccount(
	provider: SigningProvider,
): Promise<LocalAccount> {
	const address = await provider.getAddress();
	return toAccount({
		address,
		signMessage: async ({ message }) => provider.signMessage(message),
		signTransaction: async (tx) => provider.signTransaction(tx),
		signTypedData: async (typedData) =>
			provider.signTypedData({
				domain: typedData.domain as Record<string, unknown>,
				types: typedData.types as Record<string, unknown>,
				primaryType: typedData.primaryType as string,
				message: typedData.message as Record<string, unknown>,
			}),
	});
}
