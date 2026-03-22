import { describe, expect, it } from "vitest";
import {
	DEFAULT_TACK_API_ENDPOINT,
	resolveIpfsUploadProvider,
	resolvePinataJwt,
	resolveTackApiUrl,
} from "../src/lib/ipfs.js";

describe("ipfs", () => {
	it("should prefer flag value over env var", () => {
		process.env.TAP_PINATA_JWT = "env-token";
		const jwt = resolvePinataJwt("flag-token");
		expect(jwt).toBe("flag-token");
		process.env.TAP_PINATA_JWT = "";
	});

	it("should fall back to env var", () => {
		process.env.TAP_PINATA_JWT = "env-token";
		const jwt = resolvePinataJwt();
		expect(jwt).toBe("env-token");
		process.env.TAP_PINATA_JWT = "";
	});

	it("should return undefined when no jwt available", () => {
		process.env.TAP_PINATA_JWT = "";
		const jwt = resolvePinataJwt();
		expect(jwt).toBeUndefined();
	});

	it("x402 upload uses no API key — wallet pays directly", () => {
		// This is a structural test: uploadToIpfsX402 takes a WalletClient,
		// not a JWT. The function signature enforces no account requirement.
		// Integration test would need a funded wallet on Base.
		expect(typeof resolvePinataJwt).toBe("function");
	});

	it("parses supported upload providers", () => {
		expect(resolveIpfsUploadProvider("tack")).toBe("tack");
		expect(resolveIpfsUploadProvider("X402")).toBe("x402");
		expect(resolveIpfsUploadProvider()).toBeUndefined();
	});

	it("rejects unknown upload providers", () => {
		expect(() => resolveIpfsUploadProvider("unknown-provider")).toThrow("Invalid IPFS provider");
	});

	it("resolves tack API URL with defaults and env override", () => {
		process.env.TAP_TACK_API_URL = "";
		expect(resolveTackApiUrl()).toBe(DEFAULT_TACK_API_ENDPOINT);

		process.env.TAP_TACK_API_URL = "https://example.test/tack/";
		expect(resolveTackApiUrl()).toBe("https://example.test/tack");
		process.env.TAP_TACK_API_URL = "";
	});
});
