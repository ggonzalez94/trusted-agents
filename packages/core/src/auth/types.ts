export interface HttpRequestComponents {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

export interface SignedHeaders {
	"Signature-Input": string;
	Signature: string;
	"Content-Digest"?: string;
}

export interface VerificationResult {
	valid: boolean;
	signerAddress?: `0x${string}`;
	keyId?: string;
	keyIdChainId?: number;
	created?: number;
	replayKey?: string;
	error?: string;
}

export interface SignerConfig {
	privateKey: `0x${string}`;
	chainId: number;
	address?: `0x${string}`;
}

export interface SignatureParams {
	created: number;
	keyId: string;
}

export interface VerifierConfig {
	maxSignatureAgeSeconds?: number;
	maxClockSkewSeconds?: number;
}

export interface IRequestSigner {
	sign(request: HttpRequestComponents): Promise<SignedHeaders>;
}

export interface IRequestVerifier {
	verify(request: HttpRequestComponents): Promise<VerificationResult>;
}
