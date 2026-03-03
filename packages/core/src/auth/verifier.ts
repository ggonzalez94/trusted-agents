import { keccak256, recoverAddress, toBytes } from "viem";
import { AuthenticationError, base64ToBytes } from "../common/index.js";
import { verifyContentDigest } from "./content-digest.js";
import { parseKeyId } from "./keyid.js";
import { buildSignatureBase } from "./signature-base.js";
import type {
	HttpRequestComponents,
	IRequestVerifier,
	SignatureParams,
	VerificationResult,
} from "./types.js";

export class RequestVerifier implements IRequestVerifier {
	async verify(request: HttpRequestComponents): Promise<VerificationResult> {
		try {
			const lowerHeaders = Object.fromEntries(
				Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]),
			);

			const signatureInput = lowerHeaders["signature-input"];
			const signature = lowerHeaders.signature;

			if (!signatureInput || !signature) {
				return {
					valid: false,
					error: "Missing Signature-Input or Signature header",
				};
			}

			// Parse Signature-Input: sig1=("@method" "@path" ...);created=123;keyid="erc8128:..."
			const params = parseSignatureInput(signatureInput);

			// Verify Content-Digest if present
			const contentDigest = lowerHeaders["content-digest"];
			if (contentDigest && request.body) {
				const digestValid = await verifyContentDigest(request.body, contentDigest);
				if (!digestValid) {
					return {
						valid: false,
						keyId: params.keyId,
						error: "Content-Digest mismatch",
					};
				}
			}

			// Reconstruct signature base
			const signatureBase = buildSignatureBase(request, params);

			// Hash and recover
			const hash = keccak256(toBytes(signatureBase));

			// Extract raw signature from header: sig1=:<base64>:
			const sigMatch = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(signature);
			if (!sigMatch) {
				return {
					valid: false,
					keyId: params.keyId,
					error: "Invalid Signature header format",
				};
			}

			const sigBytes = base64ToBytes(sigMatch[1]!);
			const sigHex = `0x${Array.from(sigBytes)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("")}` as `0x${string}`;

			const recovered = await recoverAddress({ hash, signature: sigHex });

			// Parse keyid to get expected address
			const parsed = parseKeyId(params.keyId);

			if (recovered.toLowerCase() !== parsed.address.toLowerCase()) {
				return {
					valid: false,
					signerAddress: recovered,
					keyId: params.keyId,
					error: "Signature address mismatch",
				};
			}

			return {
				valid: true,
				signerAddress: recovered,
				keyId: params.keyId,
			};
		} catch (error) {
			if (error instanceof AuthenticationError) {
				return {
					valid: false,
					error: error.message,
				};
			}
			return {
				valid: false,
				error: error instanceof Error ? error.message : "Unknown verification error",
			};
		}
	}
}

function parseSignatureInput(input: string): SignatureParams {
	// Format: sig1=("@method" "@path" "@authority" ...);created=123;keyid="erc8128:..."
	const createdMatch = /;created=(\d+)/.exec(input);
	if (!createdMatch) {
		throw new AuthenticationError("Missing created parameter in Signature-Input");
	}

	const keyidMatch = /;keyid="([^"]+)"/.exec(input);
	if (!keyidMatch) {
		throw new AuthenticationError("Missing keyid parameter in Signature-Input");
	}

	return {
		created: Number.parseInt(createdMatch[1]!, 10),
		keyId: keyidMatch[1]!,
	};
}
