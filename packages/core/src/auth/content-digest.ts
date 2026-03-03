import { bytesToBase64 } from "../common/index.js";

export async function computeContentDigest(body: string | Uint8Array): Promise<string> {
	const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
	const hashBuffer = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
	const base64 = bytesToBase64(new Uint8Array(hashBuffer));
	return `sha-256=:${base64}:`;
}

export async function verifyContentDigest(
	body: string | Uint8Array,
	digest: string,
): Promise<boolean> {
	const expected = await computeContentDigest(body);
	return expected === digest;
}
