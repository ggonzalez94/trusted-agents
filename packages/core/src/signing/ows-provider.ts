import {
	getWallet as owsGetWallet,
	signMessage as owsSignMessage,
	signTransaction as owsSignTransaction,
	signTypedData as owsSignTypedData,
} from "@open-wallet-standard/core";
import type { Hex, SignableMessage, TransactionSerializable } from "viem";
import { serializeTransaction, toHex } from "viem";
import type {
	AuthorizationParameters,
	SignTypedDataParameters,
	SignedAuthorization,
	SigningProvider,
} from "./provider.js";

type TypedDataField = { name: string; type: string };

function ensureHexPrefix(value: string): Hex {
	if (value.startsWith("0x")) {
		return value as Hex;
	}
	return `0x${value}` as Hex;
}

function inferDomainTypes(domain: Record<string, unknown>): TypedDataField[] {
	const fields: TypedDataField[] = [];
	if (domain.name !== undefined) fields.push({ name: "name", type: "string" });
	if (domain.version !== undefined) fields.push({ name: "version", type: "string" });
	if (domain.chainId !== undefined) fields.push({ name: "chainId", type: "uint256" });
	if (domain.verifyingContract !== undefined) {
		fields.push({ name: "verifyingContract", type: "address" });
	}
	if (domain.salt !== undefined) fields.push({ name: "salt", type: "bytes32" });
	return fields;
}

function normalizeTypedDataForOws(value: SignTypedDataParameters): SignTypedDataParameters {
	if ("EIP712Domain" in value.types) {
		return value;
	}

	const domainTypes = inferDomainTypes(value.domain);
	if (domainTypes.length === 0) {
		return value;
	}

	return {
		...value,
		types: {
			EIP712Domain: domainTypes,
			...value.types,
		},
	};
}

function stringifyTypedData(value: SignTypedDataParameters): string {
	const normalized = normalizeTypedDataForOws(value);
	return JSON.stringify(normalized, (_key, item) =>
		typeof item === "bigint" ? item.toString() : item,
	);
}

/**
 * SigningProvider backed by Open Wallet Standard (OWS).
 *
 * Delegates all cryptographic operations to the OWS vault via its native SDK.
 * TAP unlocks the local OWS wallet with its passphrase so it can use the
 * native signing primitives OWS exposes for the wallet.
 */
export class OwsSigningProvider implements SigningProvider {
	private cachedAddress: `0x${string}` | undefined;

	constructor(
		private readonly walletName: string,
		private readonly chain: string,
		private readonly passphrase: string,
	) {}

	async getAddress(): Promise<`0x${string}`> {
		if (this.cachedAddress) {
			return this.cachedAddress;
		}

		const wallet = owsGetWallet(this.walletName);
		const account = wallet.accounts.find((a) => a.chainId.startsWith("eip155:"));

		if (!account) {
			throw new Error(
				`No EVM account found in wallet "${this.walletName}". ` +
					`Available chains: ${wallet.accounts.map((a) => a.chainId).join(", ")}`,
			);
		}

		this.cachedAddress = account.address as `0x${string}`;
		return this.cachedAddress;
	}

	async signMessage(message: SignableMessage): Promise<Hex> {
		let messageStr: string;
		let encoding: string | undefined;

		if (typeof message === "string") {
			messageStr = message;
		} else {
			// message is { raw: Hex | Uint8Array }
			const raw = message.raw;
			if (raw instanceof Uint8Array) {
				messageStr = toHex(raw).slice(2); // strip 0x for OWS hex encoding
			} else {
				// Already a Hex string — strip 0x prefix for OWS
				messageStr = raw.startsWith("0x") ? raw.slice(2) : raw;
			}
			encoding = "hex";
		}

		const result = owsSignMessage(
			this.walletName,
			this.chain,
			messageStr,
			this.passphrase,
			encoding,
		);

		return ensureHexPrefix(result.signature);
	}

	async signTypedData(params: SignTypedDataParameters): Promise<Hex> {
		const result = owsSignTypedData(
			this.walletName,
			this.chain,
			stringifyTypedData(params),
			this.passphrase,
		);
		return ensureHexPrefix(result.signature);
	}

	async signTransaction(tx: TransactionSerializable): Promise<Hex> {
		const serialized = serializeTransaction(tx);
		// Remove the 0x prefix — OWS expects raw hex
		const txHex = serialized.slice(2);

		const result = owsSignTransaction(this.walletName, this.chain, txHex, this.passphrase);

		return ensureHexPrefix(result.signature);
	}

	async signAuthorization(params: AuthorizationParameters): Promise<SignedAuthorization> {
		const { chainId, nonce } = params;

		if (chainId === undefined) {
			throw new Error("chainId is required for signAuthorization");
		}
		if (nonce === undefined) {
			throw new Error("nonce is required for signAuthorization");
		}

		throw new Error(
			`OWS wallet "${this.walletName}" does not support raw EIP-7702 authorization signing`,
		);
	}

	supportsAuthorizationSignatures(): boolean {
		return false;
	}
}
