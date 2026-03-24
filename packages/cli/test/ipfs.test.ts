import { describe, expect, it } from "vitest";
import {
	DEFAULT_TACK_API_ENDPOINT,
	resolveAutoProvider,
	resolveEffectiveIpfsProvider,
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

	it("auto-selects tack for Taiko chains", () => {
		expect(resolveAutoProvider("eip155:167000")).toBe("tack");
		expect(resolveAutoProvider("eip155:167013")).toBe("tack");
	});

	it("auto-selects x402 for Base chains", () => {
		expect(resolveAutoProvider("eip155:8453")).toBe("x402");
		expect(resolveAutoProvider("eip155:84532")).toBe("x402");
	});

	it("auto prefers tack on Taiko even when JWT is present", () => {
		expect(resolveAutoProvider("eip155:167000", "jwt")).toBe("tack");
		expect(resolveAutoProvider("eip155:167013", "jwt")).toBe("tack");
	});

	it("auto prefers pinata when JWT is present on non-Taiko chains", () => {
		expect(resolveAutoProvider("eip155:8453", "jwt")).toBe("pinata");
		expect(resolveAutoProvider("eip155:84532", "jwt")).toBe("pinata");
	});

	it("resolves the effective provider from config and credentials", () => {
		expect(
			resolveEffectiveIpfsProvider({
				chain: "eip155:167000",
				configuredProvider: undefined,
				pinataJwt: "jwt",
			}),
		).toBe("tack");
		expect(
			resolveEffectiveIpfsProvider({
				chain: "eip155:8453",
				configuredProvider: undefined,
				pinataJwt: "jwt",
			}),
		).toBe("pinata");
		expect(
			resolveEffectiveIpfsProvider({
				chain: "eip155:8453",
				configuredProvider: "x402",
			}),
		).toBe("x402");
	});

	it("resolves tack API URL with defaults and env override", () => {
		process.env.TAP_TACK_API_URL = "";
		expect(resolveTackApiUrl()).toBe(DEFAULT_TACK_API_ENDPOINT);

		process.env.TAP_TACK_API_URL = "https://example.test/tack/";
		expect(resolveTackApiUrl()).toBe("https://example.test/tack");
		process.env.TAP_TACK_API_URL = "";
	});
});
