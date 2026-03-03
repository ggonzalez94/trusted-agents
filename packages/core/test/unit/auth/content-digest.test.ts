import { describe, expect, it } from "vitest";
import { computeContentDigest, verifyContentDigest } from "../../../src/auth/content-digest.js";

describe("computeContentDigest", () => {
	it("should produce a sha-256 digest in the expected format", async () => {
		const body = '{"hello":"world"}';
		const digest = await computeContentDigest(body);

		expect(digest).toMatch(/^sha-256=:[A-Za-z0-9+/=]+:$/);
	});

	it("should produce deterministic output for the same input", async () => {
		const body = "test body content";
		const digest1 = await computeContentDigest(body);
		const digest2 = await computeContentDigest(body);

		expect(digest1).toBe(digest2);
	});

	it("should produce different digests for different inputs", async () => {
		const digest1 = await computeContentDigest("body-a");
		const digest2 = await computeContentDigest("body-b");

		expect(digest1).not.toBe(digest2);
	});

	it("should accept Uint8Array input", async () => {
		const body = new TextEncoder().encode("binary body");
		const digest = await computeContentDigest(body);

		expect(digest).toMatch(/^sha-256=:/);
	});

	it("should produce the same digest for string and equivalent Uint8Array", async () => {
		const str = "equivalent content";
		const bytes = new TextEncoder().encode(str);

		const digestStr = await computeContentDigest(str);
		const digestBytes = await computeContentDigest(bytes);

		expect(digestStr).toBe(digestBytes);
	});
});

describe("verifyContentDigest", () => {
	it("should return true for a valid body and digest", async () => {
		const body = '{"test":"data"}';
		const digest = await computeContentDigest(body);

		const valid = await verifyContentDigest(body, digest);
		expect(valid).toBe(true);
	});

	it("should return false for a tampered body", async () => {
		const body = '{"test":"data"}';
		const digest = await computeContentDigest(body);

		const valid = await verifyContentDigest('{"test":"tampered"}', digest);
		expect(valid).toBe(false);
	});

	it("should return false for a tampered digest", async () => {
		const body = "some content";
		const valid = await verifyContentDigest(body, "sha-256=:aW52YWxpZA==:");
		expect(valid).toBe(false);
	});
});
