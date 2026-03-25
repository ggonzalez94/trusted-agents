import type { Hex, SignableMessage, TransactionSerializable } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
	AuthorizationParameters,
	SignTypedDataParameters,
	SignedAuthorization,
	SigningProvider,
} from "../../src/signing/provider.js";

// Well-known Hardhat/Anvil test private keys (never use in production)
export const ALICE_PRIVATE_KEY =
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const BOB_PRIVATE_KEY =
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

export const ALICE = {
	privateKey: ALICE_PRIVATE_KEY,
	account: privateKeyToAccount(ALICE_PRIVATE_KEY),
	get address() {
		return this.account.address;
	},
};

export const BOB = {
	privateKey: BOB_PRIVATE_KEY,
	account: privateKeyToAccount(BOB_PRIVATE_KEY),
	get address() {
		return this.account.address;
	},
};

/**
 * Creates a SigningProvider backed by a local private key for test purposes only.
 */
export function createTestSigningProvider(privateKey: `0x${string}`): SigningProvider {
	const account = privateKeyToAccount(privateKey);
	return {
		async getAddress(): Promise<`0x${string}`> {
			return account.address;
		},
		async signMessage(message: SignableMessage): Promise<Hex> {
			return account.signMessage({ message });
		},
		async signTypedData(params: SignTypedDataParameters): Promise<Hex> {
			return account.signTypedData(params as Parameters<typeof account.signTypedData>[0]);
		},
		async signTransaction(tx: TransactionSerializable): Promise<Hex> {
			return account.signTransaction(tx as Parameters<typeof account.signTransaction>[0]);
		},
		async signAuthorization(_params: AuthorizationParameters): Promise<SignedAuthorization> {
			throw new Error("signAuthorization not implemented in test provider");
		},
	};
}

export const ALICE_SIGNING_PROVIDER = createTestSigningProvider(ALICE_PRIVATE_KEY);
export const BOB_SIGNING_PROVIDER = createTestSigningProvider(BOB_PRIVATE_KEY);
