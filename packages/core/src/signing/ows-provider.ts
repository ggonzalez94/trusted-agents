import {
	getWallet as owsGetWallet,
	signMessage as owsSignMessage,
	signTransaction as owsSignTransaction,
	signTypedData as owsSignTypedData,
} from "@open-wallet-standard/core";
import type { Hex, SignableMessage, TransactionSerializable } from "viem";
import { concatHex, keccak256, numberToHex, serializeTransaction, toHex, toRlp } from "viem";
import type {
	AuthorizationParameters,
	SignTypedDataParameters,
	SignedAuthorization,
	SigningProvider,
} from "./provider.js";

/** EIP-712 domain field → Solidity type, in spec-canonical order. */
const EIP712_DOMAIN_FIELDS: ReadonlyArray<readonly [string, string]> = [
	["name", "string"],
	["version", "string"],
	["chainId", "uint256"],
	["verifyingContract", "address"],
	["salt", "bytes32"],
];

function ensureHexPrefix(value: string): Hex {
	if (value.startsWith("0x")) {
		return value as Hex;
	}
	return `0x${value}` as Hex;
}

/**
 * SigningProvider backed by Open Wallet Standard (OWS).
 *
 * Delegates all cryptographic operations to the OWS vault via its native SDK.
 * The `apiKey` is passed as the `passphrase` parameter to OWS signing functions,
 * which uses it for API-key-based authentication and policy enforcement.
 */
export class OwsSigningProvider implements SigningProvider {
	private cachedAddress: `0x${string}` | undefined;

	constructor(
		private readonly walletName: string,
		private readonly chain: string,
		private readonly apiKey: string,
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

		const result = owsSignMessage(this.walletName, this.chain, messageStr, this.apiKey, encoding);

		return ensureHexPrefix(result.signature);
	}

	async signTypedData(params: SignTypedDataParameters): Promise<Hex> {
		const { domain, types, primaryType, message } = params;

		// OWS requires EIP712Domain in the types object. Build it from whichever
		// domain fields are present, then let it override any caller-provided one
		// (callers should not pass EIP712Domain — OWS infers validation from it).
		const domainFields = EIP712_DOMAIN_FIELDS.filter(([key]) => domain[key] !== undefined).map(
			([name, type]) => ({ name, type }),
		);

		const typedDataJson = JSON.stringify(
			{ types: { ...types, EIP712Domain: domainFields }, primaryType, domain, message },
			(_key, value) => (typeof value === "bigint" ? value.toString() : value),
		);

		const result = owsSignTypedData(this.walletName, this.chain, typedDataJson, this.apiKey);

		return ensureHexPrefix(result.signature);
	}

	async signTransaction(tx: TransactionSerializable): Promise<Hex> {
		const serialized = serializeTransaction(tx);
		// Remove the 0x prefix — OWS expects raw hex
		const txHex = serialized.slice(2);

		const result = owsSignTransaction(this.walletName, this.chain, txHex, this.apiKey);

		return ensureHexPrefix(result.signature);
	}

	async signAuthorization(params: AuthorizationParameters): Promise<SignedAuthorization> {
		const { contractAddress, chainId, nonce } = params;

		if (chainId === undefined) {
			throw new Error("chainId is required for signAuthorization");
		}
		if (nonce === undefined) {
			throw new Error("nonce is required for signAuthorization");
		}

		// EIP-7702 authorization hash:
		// keccak256(0x05 || rlp([chain_id, address, nonce]))
		const encoded = toRlp([numberToHex(chainId), contractAddress, numberToHex(nonce)]);
		const authHash = keccak256(concatHex(["0x05", encoded]));

		// Sign the raw hash using signMessage with hex encoding
		// Strip 0x prefix — OWS expects raw hex
		const result = owsSignMessage(
			this.walletName,
			this.chain,
			authHash.slice(2),
			this.apiKey,
			"hex",
		);

		const sig = ensureHexPrefix(result.signature);

		// Parse r, s, v from the 65-byte signature
		// Signature format: r (32 bytes) + s (32 bytes) + v (1 byte) = 65 bytes = 130 hex chars
		const sigBytes = sig.slice(2); // remove 0x
		if (sigBytes.length !== 130) {
			throw new Error(
				`Expected 65-byte signature (130 hex chars), got ${sigBytes.length} hex chars`,
			);
		}

		const r = `0x${sigBytes.slice(0, 64)}` as Hex;
		const s = `0x${sigBytes.slice(64, 128)}` as Hex;
		const vByte = Number.parseInt(sigBytes.slice(128, 130), 16);
		// Normalize v: if v is 0 or 1 (recovery id), convert to 27/28
		const v = BigInt(vByte < 27 ? vByte + 27 : vByte);

		return {
			contractAddress,
			chainId,
			nonce,
			r,
			s,
			v,
		};
	}
}
