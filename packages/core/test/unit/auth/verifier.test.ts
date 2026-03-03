import { describe, expect, it } from "vitest";
import { RequestSigner } from "../../../src/auth/signer.js";
import type { HttpRequestComponents } from "../../../src/auth/types.js";
import { RequestVerifier } from "../../../src/auth/verifier.js";
import { nowUnix } from "../../../src/common/time.js";
import { ALICE, BOB } from "../../fixtures/test-keys.js";

describe("RequestVerifier", () => {
	const verifier = new RequestVerifier();

	it("should return invalid when Signature-Input header is missing", async () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: {},
			body: "{}",
		};

		const result = await verifier.verify(request);

		expect(result.valid).toBe(false);
		expect(result.error).toContain("Missing Signature-Input or Signature header");
	});

	it("should return invalid when Signature header is missing", async () => {
		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: {
				"Signature-Input":
					'sig1=("@method");created=123;keyid="erc8128:1:0x0000000000000000000000000000000000000000"',
			},
			body: "{}",
		};

		const result = await verifier.verify(request);

		expect(result.valid).toBe(false);
		expect(result.error).toContain("Missing Signature-Input or Signature header");
	});

	it("should return invalid for a malformed Signature header", async () => {
		const created = nowUnix();
		const request: HttpRequestComponents = {
			method: "GET",
			url: "https://agent.example.com/a2a",
			headers: {
				"Signature-Input": `sig1=("@method" "@path" "@authority");created=${created};keyid="erc8128:1:${ALICE.address}"`,
				Signature: "not-valid-format",
			},
		};

		const result = await verifier.verify(request);

		expect(result.valid).toBe(false);
		expect(result.error).toContain("Invalid Signature header format");
	});

	it("should detect wrong key: recovered address does not match keyid", async () => {
		// Sign with Alice's key but claim to be Bob in the keyid
		const aliceSigner = new RequestSigner({
			privateKey: ALICE.privateKey,
			chainId: 1,
			address: ALICE.address,
		});

		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ test: true }),
		};

		const signed = await aliceSigner.sign(request);

		// Replace the keyid in Signature-Input to claim Bob's address
		const tamperedInput = signed["Signature-Input"].replace(ALICE.address, BOB.address);

		const verifiableRequest: HttpRequestComponents = {
			...request,
			headers: {
				...request.headers,
				"Signature-Input": tamperedInput,
				Signature: signed.Signature,
				...(signed["Content-Digest"] ? { "Content-Digest": signed["Content-Digest"] } : {}),
			},
		};

		const result = await verifier.verify(verifiableRequest);

		expect(result.valid).toBe(false);
		// The signature base includes the keyid, so tampering the keyid changes the hash,
		// causing recovery to produce a different address than expected.
		// The verifier should detect that the recovered address doesn't match the claimed keyid.
		expect(result.error).toContain("Signature address mismatch");
		expect(result.signerAddress).toBeDefined();
	});

	it("should verify a valid signed request successfully", async () => {
		const signer = new RequestSigner({
			privateKey: BOB.privateKey,
			chainId: 1,
			address: BOB.address,
		});

		const request: HttpRequestComponents = {
			method: "POST",
			url: "https://agent.example.com/a2a",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "from Bob" }),
		};

		const signed = await signer.sign(request);

		const verifiableRequest: HttpRequestComponents = {
			...request,
			headers: {
				...request.headers,
				...signed,
			},
		};

		const result = await verifier.verify(verifiableRequest);

		expect(result.valid).toBe(true);
		expect(result.signerAddress?.toLowerCase()).toBe(BOB.address.toLowerCase());
		expect(result.keyId).toBe(`erc8128:1:${BOB.address}`);
	});
});
