import type { HttpRequestComponents, SignatureParams } from "./types.js";

function getCanonicalUrl(url: string): URL {
	return new URL(url, "http://localhost");
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

export function defaultCoveredComponents(components: HttpRequestComponents): string[] {
	const lowerHeaders = normalizeHeaders(components.headers);
	const covered: string[] = ["@method", "@path", "@authority"];

	if (lowerHeaders["content-digest"]) {
		covered.push("content-digest");
	}

	if (lowerHeaders["content-type"]) {
		covered.push("content-type");
	}

	return covered;
}

export function buildSignatureBase(
	components: HttpRequestComponents,
	params: SignatureParams,
	coveredComponents = defaultCoveredComponents(components),
): string {
	const url = getCanonicalUrl(components.url);
	const path = `${url.pathname}${url.search}`;
	const authority = url.host;

	const lines: string[] = [
		`"@method": ${components.method.toUpperCase()}`,
		`"@path": ${path}`,
		`"@authority": ${authority}`,
	];

	const lowerHeaders = normalizeHeaders(components.headers);

	if (coveredComponents.includes("content-digest")) {
		lines.push(`"content-digest": ${lowerHeaders["content-digest"]}`);
	}

	if (coveredComponents.includes("content-type")) {
		lines.push(`"content-type": ${lowerHeaders["content-type"]}`);
	}

	const componentsList = coveredComponents.map((c) => `"${c}"`).join(" ");
	const sigParams = `(${componentsList});created=${params.created};keyid="${params.keyId}"`;
	lines.push(`"@signature-params": ${sigParams}`);

	return `${lines.join("\n")}\n`;
}

export function buildSignatureInput(
	params: SignatureParams,
	components: HttpRequestComponents,
	coveredComponents = defaultCoveredComponents(components),
): string {
	const componentsList = coveredComponents.map((c) => `"${c}"`).join(" ");
	return `sig1=(${componentsList});created=${params.created};keyid="${params.keyId}"`;
}
