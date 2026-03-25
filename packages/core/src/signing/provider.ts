import type { Hex, SignableMessage, TransactionSerializable } from "viem";

export interface SignTypedDataParameters {
	domain: Record<string, unknown>;
	types: Record<string, unknown>;
	primaryType: string;
	message: Record<string, unknown>;
}

export interface SignedAuthorization {
	contractAddress: `0x${string}`;
	chainId: number;
	nonce: number;
	r: Hex;
	s: Hex;
	v: bigint;
}

export interface AuthorizationParameters {
	contractAddress: `0x${string}`;
	chainId?: number;
	nonce?: number;
}

export interface SigningProvider {
	getAddress(): Promise<`0x${string}`>;
	signMessage(message: SignableMessage): Promise<Hex>;
	signTypedData(params: SignTypedDataParameters): Promise<Hex>;
	signTransaction(tx: TransactionSerializable): Promise<Hex>;
	signAuthorization(params: AuthorizationParameters): Promise<SignedAuthorization>;
}
