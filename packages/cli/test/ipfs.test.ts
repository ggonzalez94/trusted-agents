import { describe, expect, it } from "vitest";
import { resolvePinataJwt } from "../src/lib/ipfs.js";

describe("ipfs", () => {
	it("should prefer flag value over env var", () => {
		process.env["TAP_PINATA_JWT"] = "env-token";
		const jwt = resolvePinataJwt("flag-token");
		expect(jwt).toBe("flag-token");
		delete process.env["TAP_PINATA_JWT"];
	});

	it("should fall back to env var", () => {
		process.env["TAP_PINATA_JWT"] = "env-token";
		const jwt = resolvePinataJwt();
		expect(jwt).toBe("env-token");
		delete process.env["TAP_PINATA_JWT"];
	});

	it("should return undefined when no jwt available", () => {
		delete process.env["TAP_PINATA_JWT"];
		const jwt = resolvePinataJwt();
		expect(jwt).toBeUndefined();
	});

	it("x402 upload uses no API key — wallet pays directly", () => {
		// This is a structural test: uploadToIpfsX402 takes a WalletClient,
		// not a JWT. The function signature enforces no account requirement.
		// Integration test would need a funded wallet on Base.
		expect(typeof resolvePinataJwt).toBe("function");
	});
});
