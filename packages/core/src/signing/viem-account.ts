import type { LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import type { SigningProvider } from "./provider.js";

export async function createSigningProviderViemAccount(
	provider: SigningProvider,
): Promise<LocalAccount> {
	const address = await provider.getAddress();
	return toAccount({
		address,
		sign: async ({ hash }) => provider.signMessage({ raw: hash }),
		signMessage: async ({ message }) => provider.signMessage(message),
		signTransaction: async (tx) => provider.signTransaction(tx),
		signTypedData: async (typedData) =>
			provider.signTypedData({
				domain: typedData.domain as Record<string, unknown>,
				types: typedData.types as Record<string, unknown>,
				primaryType: typedData.primaryType as string,
				message: typedData.message as Record<string, unknown>,
			}),
		signAuthorization: async (authorization) => {
			const contractAddress =
				"contractAddress" in authorization
					? authorization.contractAddress!
					: authorization.address!;
			const signed = await provider.signAuthorization({
				contractAddress,
				chainId: authorization.chainId,
				nonce: authorization.nonce,
			});
			// Map our SignedAuthorization to viem's expected format:
			// viem uses `address` (not `contractAddress`) and requires `yParity`
			const v = signed.v;
			const yParity = v >= 27n ? Number(v - 27n) : Number(v);
			return {
				address: signed.contractAddress,
				chainId: signed.chainId,
				nonce: signed.nonce,
				r: signed.r,
				s: signed.s,
				v: signed.v,
				yParity,
			};
		},
	}) as LocalAccount;
}
