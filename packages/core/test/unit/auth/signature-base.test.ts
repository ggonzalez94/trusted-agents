import { describe, expect, it } from "vitest";
import { buildSignatureBase, buildSignatureInput } from "../../../src/auth/signature-base.js";
import type { HttpRequestComponents, SignatureParams } from "../../../src/auth/types.js";
import { ALICE } from "../../fixtures/test-keys.js";

describe("buildSignatureBase", () => {
	const params: SignatureParams = {
		created: 1700000000,
		keyId: `erc8128:1:${ALICE.address}`,
	};

	it("should include @method, @path, @authority, and @signature-params", () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: {},
		};

		const base = buildSignatureBase(request, params);
		const lines = base.trimEnd().split("\n");

		expect(lines[0]).toBe('"@method": POST');
		expect(lines[1]).toBe('"@path": /a2a');
		expect(lines[2]).toBe('"@authority": agent.example.com');
		expect(lines[3]).toContain('"@signature-params":');
		expect(lines[3]).toContain("created=1700000000");
		expect(lines[3]).toContain(`keyid="erc8128:1:${ALICE.address}"`);
	});

	it("should include content-digest when present in headers", () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: {
				"Content-Digest": "sha-256=:abc123=:",
			},
		};

		const base = buildSignatureBase(request, params);

		expect(base).toContain('"content-digest": sha-256=:abc123=:');
	});

	it("should include content-type when present in headers", () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: {
				"Content-Type": "application/json",
			},
		};

		const base = buildSignatureBase(request, params);

		expect(base).toContain('"content-type": application/json');
	});

	it("should handle case-insensitive headers", () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: {
				"CONTENT-TYPE": "application/json",
				"CONTENT-DIGEST": "sha-256=:test=:",
			},
		};

		const base = buildSignatureBase(request, params);

		expect(base).toContain('"content-type": application/json');
		expect(base).toContain('"content-digest": sha-256=:test=:');
	});
});

describe("buildSignatureInput", () => {
	const params: SignatureParams = {
		created: 1700000000,
		keyId: `erc8128:1:${ALICE.address}`,
	};

	it("should produce a valid Signature-Input string", () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a?x=1",
			headers: {},
		};

		const input = buildSignatureInput(params, request);

		expect(input).toBe(
			`sig1=("@method" "@path" "@authority");created=1700000000;keyid="erc8128:1:${ALICE.address}"`,
		);
	});

	it("should include content-digest and content-type when present", () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: {
				"Content-Digest": "sha-256=:abc=:",
				"Content-Type": "application/json",
			},
		};

		const input = buildSignatureInput(params, request);

		expect(input).toContain('"content-digest"');
		expect(input).toContain('"content-type"');
	});
});
