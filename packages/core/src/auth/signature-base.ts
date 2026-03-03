import type { HttpRequestComponents, SignatureParams } from "./types.js";

export function buildSignatureBase(
	components: HttpRequestComponents,
	params: SignatureParams,
): string {
	const url = new URL(components.url, "http://localhost");
	const path = url.pathname;
	const authority = url.host;

	const coveredComponents: string[] = ["@method", "@path", "@authority"];

	const lines: string[] = [
		`"@method": ${components.method.toUpperCase()}`,
		`"@path": ${path}`,
		`"@authority": ${authority}`,
	];

	const lowerHeaders = Object.fromEntries(
		Object.entries(components.headers).map(([k, v]) => [k.toLowerCase(), v]),
	);

	if (lowerHeaders["content-digest"]) {
		coveredComponents.push("content-digest");
		lines.push(`"content-digest": ${lowerHeaders["content-digest"]}`);
	}

	if (lowerHeaders["content-type"]) {
		coveredComponents.push("content-type");
		lines.push(`"content-type": ${lowerHeaders["content-type"]}`);
	}

	const componentsList = coveredComponents.map((c) => `"${c}"`).join(" ");
	const sigParams = `(${componentsList});created=${params.created};keyid="${params.keyId}"`;
	lines.push(`"@signature-params": ${sigParams}`);

	return lines.join("\n");
}

export function buildSignatureInput(
	params: SignatureParams,
	components: HttpRequestComponents,
): string {
	const coveredComponents: string[] = ["@method", "@path", "@authority"];

	const lowerHeaders = Object.fromEntries(
		Object.entries(components.headers).map(([k, v]) => [k.toLowerCase(), v]),
	);

	if (lowerHeaders["content-digest"]) {
		coveredComponents.push("content-digest");
	}

	if (lowerHeaders["content-type"]) {
		coveredComponents.push("content-type");
	}

	const componentsList = coveredComponents.map((c) => `"${c}"`).join(" ");
	return `sig1=(${componentsList});created=${params.created};keyid="${params.keyId}"`;
}
