import type { Signer } from "@xmtp/node-sdk";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** IdentifierKind.Ethereum from @xmtp/node-bindings (const enum, value inlined to avoid verbatimModuleSyntax issues) */
const IDENTIFIER_KIND_ETHEREUM = 0 as const;

export function createXmtpSigner(privateKey: `0x${string}`): Signer {
	const account = privateKeyToAccount(privateKey);

	return {
		type: "EOA",
		getIdentifier: () => ({
			identifier: account.address,
			identifierKind: IDENTIFIER_KIND_ETHEREUM,
		}),
		signMessage: async (message: string): Promise<Uint8Array> => {
			const signature = await account.signMessage({ message });
			return hexToBytes(signature);
		},
	};
}
