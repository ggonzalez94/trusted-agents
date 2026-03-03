import { keccak256, recoverAddress, toBytes } from "viem";
import { AuthenticationError, base64ToBytes } from "../common/index.js";
import { nowUnix } from "../common/index.js";
import { verifyContentDigest } from "./content-digest.js";
import { parseKeyId } from "./keyid.js";
import { buildSignatureBase } from "./signature-base.js";
import type {
	HttpRequestComponents,
	IRequestVerifier,
	SignatureParams,
	VerificationResult,
	VerifierConfig,
} from "./types.js";

interface ParsedSignatureInput extends SignatureParams {
	coveredComponents: string[];
}

export class RequestVerifier implements IRequestVerifier {
	private readonly maxSignatureAgeSeconds: number;
	private readonly maxClockSkewSeconds: number;
	private readonly replayCache = new Map<string, number>();

	constructor(config: VerifierConfig = {}) {
		this.maxSignatureAgeSeconds = config.maxSignatureAgeSeconds ?? 300;
		this.maxClockSkewSeconds = config.maxClockSkewSeconds ?? 30;
	}

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
			const parsedKeyId = parseKeyId(params.keyId);
			const now = nowUnix();

			if (params.created > now + this.maxClockSkewSeconds) {
				return {
					valid: false,
					keyId: params.keyId,
					keyIdChainId: parsedKeyId.chainId,
					created: params.created,
					error: "Signature created timestamp is too far in the future",
				};
			}

			if (params.created < now - this.maxSignatureAgeSeconds) {
				return {
					valid: false,
					keyId: params.keyId,
					keyIdChainId: parsedKeyId.chainId,
					created: params.created,
					error: "Signature has expired",
				};
			}

			if (
				!params.coveredComponents.includes("@method") ||
				!params.coveredComponents.includes("@path") ||
				!params.coveredComponents.includes("@authority")
			) {
				return {
					valid: false,
					keyId: params.keyId,
					error: "Signature-Input is missing required covered components",
				};
			}

			const hasBody = Object.prototype.hasOwnProperty.call(request, "body");

			// Verify Content-Digest for all body-bearing requests (including empty string body)
			const contentDigest = lowerHeaders["content-digest"];
			if (hasBody && !contentDigest) {
				return {
					valid: false,
					keyId: params.keyId,
					error: "Missing Content-Digest header for request body",
				};
			}

			if (hasBody && !params.coveredComponents.includes("content-digest")) {
				return {
					valid: false,
					keyId: params.keyId,
					error: "Signature-Input must cover content-digest when request has a body",
				};
			}

			if (hasBody && contentDigest) {
				const digestValid = await verifyContentDigest(request.body ?? "", contentDigest);
				if (!digestValid) {
					return {
						valid: false,
						keyId: params.keyId,
						error: "Content-Digest mismatch",
					};
				}
			}

			// Reconstruct signature base
			const signatureBase = buildSignatureBase(request, params, params.coveredComponents);

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
			if (recovered.toLowerCase() !== parsedKeyId.address.toLowerCase()) {
				return {
					valid: false,
					signerAddress: recovered,
					keyId: params.keyId,
					error: "Signature address mismatch",
				};
			}

			const replayKey = `${params.keyId}:${params.created}:${signature}`;
			this.cleanupReplayCache(now);
			if (this.replayCache.has(replayKey)) {
				return {
					valid: false,
					signerAddress: parsedKeyId.address,
					keyId: params.keyId,
					keyIdChainId: parsedKeyId.chainId,
					created: params.created,
					replayKey,
					error: "Replay detected",
				};
			}
			this.replayCache.set(replayKey, now + this.maxSignatureAgeSeconds + this.maxClockSkewSeconds);

			return {
				valid: true,
				signerAddress: recovered,
				keyId: params.keyId,
				keyIdChainId: parsedKeyId.chainId,
				created: params.created,
				replayKey,
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
				error: "Signature verification failed",
			};
		}
	}

	private cleanupReplayCache(now: number): void {
		for (const [key, expiresAt] of this.replayCache.entries()) {
			if (expiresAt < now) {
				this.replayCache.delete(key);
			}
		}
	}
}

function parseSignatureInput(input: string): ParsedSignatureInput {
	// Format: sig1=("@method" "@path" "@authority" ...);created=123;keyid="erc8128:..."
	const coveredComponentsMatch = /^sig1=\(([^)]*)\)/.exec(input);
	if (!coveredComponentsMatch) {
		throw new AuthenticationError("Missing covered components in Signature-Input");
	}

	const coveredComponents = Array.from(coveredComponentsMatch[1]!.matchAll(/"([^"]+)"/g)).map(
		(m) => m[1]!,
	);

	if (coveredComponents.length === 0) {
		throw new AuthenticationError("Signature-Input must include covered components");
	}

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
		coveredComponents,
	};
}
