export type {
	HttpRequestComponents,
	SignedHeaders,
	VerificationResult,
	SignerConfig,
	SignatureParams,
	IRequestSigner,
	IRequestVerifier,
} from "./types.js";

export { parseKeyId, formatKeyId } from "./keyid.js";
export type { ParsedKeyId } from "./keyid.js";

export { computeContentDigest, verifyContentDigest } from "./content-digest.js";

export { buildSignatureBase, buildSignatureInput } from "./signature-base.js";

export { RequestSigner } from "./signer.js";

export { RequestVerifier } from "./verifier.js";
