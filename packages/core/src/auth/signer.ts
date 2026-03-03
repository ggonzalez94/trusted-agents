import { keccak256, toBytes } from "viem";
import { sign } from "viem/accounts";
import { bytesToBase64, nowUnix } from "../common/index.js";
import { computeContentDigest } from "./content-digest.js";
import { formatKeyId } from "./keyid.js";
import { buildSignatureBase, buildSignatureInput } from "./signature-base.js";
import type {
	HttpRequestComponents,
	IRequestSigner,
	SignedHeaders,
	SignerConfig,
} from "./types.js";

export class RequestSigner implements IRequestSigner {
	private readonly privateKey: `0x${string}`;
	private readonly keyId: string;

	constructor(config: SignerConfig) {
		this.privateKey = config.privateKey;
		this.keyId = formatKeyId(config.chainId, config.address);
	}

	async sign(request: HttpRequestComponents): Promise<SignedHeaders> {
		const headers: SignedHeaders = {
			"Signature-Input": "",
			Signature: "",
		};

		// Compute Content-Digest if body exists
		let effectiveRequest = request;
		if (request.body) {
			const contentDigest = await computeContentDigest(request.body);
			headers["Content-Digest"] = contentDigest;
			effectiveRequest = {
				...request,
				headers: {
					...request.headers,
					"Content-Digest": contentDigest,
				},
			};
		}

		const created = nowUnix();
		const params = { created, keyId: this.keyId };

		const signatureBase = buildSignatureBase(effectiveRequest, params);
		const signatureInput = buildSignatureInput(params, effectiveRequest);

		const hash = keccak256(toBytes(signatureBase));
		const sig = await sign({ hash, privateKey: this.privateKey, to: "hex" });

		const sigBytes = toBytes(sig);
		const sigBase64 = bytesToBase64(sigBytes);

		headers["Signature-Input"] = signatureInput;
		headers.Signature = `sig1=:${sigBase64}:`;

		return headers;
	}
}
