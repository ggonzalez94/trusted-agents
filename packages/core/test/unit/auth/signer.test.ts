import { describe, expect, it } from "vitest";
import { RequestSigner } from "../../../src/auth/signer.js";
import type { HttpRequestComponents } from "../../../src/auth/types.js";
import { RequestVerifier } from "../../../src/auth/verifier.js";
import { ALICE } from "../../fixtures/test-keys.js";
import { createAliceSignerConfig } from "../../helpers/test-agent.js";

describe("RequestSigner", () => {
	const config = createAliceSignerConfig();
	const signer = new RequestSigner(config);

	it("should sign a request with body and produce all required headers", async () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "message/send", id: "1" }),
		};

		const signed = await signer.sign(request);

		expect(signed["Signature-Input"]).toBeDefined();
		expect(signed["Signature-Input"]).toMatch(/^sig1=\(/);
		expect(signed["Signature-Input"]).toContain("created=");
		expect(signed["Signature-Input"]).toContain(`keyid="erc8128:1:${ALICE.address}"`);

		expect(signed.Signature).toBeDefined();
		expect(signed.Signature).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);

		expect(signed["Content-Digest"]).toBeDefined();
		expect(signed["Content-Digest"]).toMatch(/^sha-256=:/);
	});

	it("should sign a request without body and omit Content-Digest", async () => {
		const request: HttpRequestComponents = {
			method: "GET",
			url: "https://agent.example.com/a2a",
			headers: {},
		};

		const signed = await signer.sign(request);

		expect(signed["Signature-Input"]).toBeDefined();
		expect(signed.Signature).toBeDefined();
		expect(signed["Content-Digest"]).toBeUndefined();
	});

	it("should round-trip: sign then verify should pass", async () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hello: "world" }),
		};

		const signed = await signer.sign(request);

		const verifiableRequest: HttpRequestComponents = {
			...request,
			headers: {
				...request.headers,
				...signed,
			},
		};

		const verifier = new RequestVerifier();
		const result = await verifier.verify(verifiableRequest);

		expect(result.valid).toBe(true);
		expect(result.signerAddress?.toLowerCase()).toBe(ALICE.address.toLowerCase());
		expect(result.keyId).toBe(`erc8128:1:${ALICE.address}`);
	});

	it("should round-trip without body", async () => {
		const request: HttpRequestComponents = {
			method: "GET",
			url: "https://agent.example.com/status",
			headers: {},
		};

		const signed = await signer.sign(request);

		const verifiableRequest: HttpRequestComponents = {
			...request,
			headers: {
				...request.headers,
				...signed,
			},
		};

		const verifier = new RequestVerifier();
		const result = await verifier.verify(verifiableRequest);

		expect(result.valid).toBe(true);
		expect(result.signerAddress?.toLowerCase()).toBe(ALICE.address.toLowerCase());
	});

	it("should fail verification when body is tampered", async () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hello: "world" }),
		};

		const signed = await signer.sign(request);

		const tamperedRequest: HttpRequestComponents = {
			...request,
			body: JSON.stringify({ hello: "tampered" }),
			headers: {
				...request.headers,
				...signed,
			},
		};

		const verifier = new RequestVerifier();
		const result = await verifier.verify(tamperedRequest);

		expect(result.valid).toBe(false);
		expect(result.error).toContain("Content-Digest mismatch");
	});
});
