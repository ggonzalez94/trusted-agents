import type { Signer } from "@xmtp/node-sdk";
import { hexToBytes } from "viem";
import type { SigningProvider } from "../signing/provider.js";

/** IdentifierKind.Ethereum from @xmtp/node-bindings (const enum, value inlined to avoid verbatimModuleSyntax issues) */
const IDENTIFIER_KIND_ETHEREUM = 0 as const;

export async function createXmtpSigner(provider: SigningProvider): Promise<Signer> {
	const address = await provider.getAddress();

	return {
		type: "EOA",
		getIdentifier: () => ({
			identifier: address,
			identifierKind: IDENTIFIER_KIND_ETHEREUM,
		}),
		signMessage: async (message: string): Promise<Uint8Array> => {
			const signature = await provider.signMessage(message);
			return hexToBytes(signature);
		},
	};
}
