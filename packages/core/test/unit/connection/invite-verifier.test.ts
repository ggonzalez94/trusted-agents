import { describe, expect, it } from "vitest";
import { parseInviteUrl, verifyInvite } from "../../../src/connection/invite-verifier.js";
import { generateInvite } from "../../../src/connection/invite.js";
import { ALICE } from "../../fixtures/test-keys.js";

describe("parseInviteUrl", () => {
	it("should parse a valid invite URL", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:1",
			account: ALICE.account,
		});

		const parsed = parseInviteUrl(url);

		expect(parsed.agentId).toBe(1);
		expect(parsed.chain).toBe("eip155:1");
		expect(parsed.expires).toBeGreaterThan(0);
		expect(parsed.signature).toMatch(/^0x/);
	});

	it("should throw for a URL missing required parameters", () => {
		expect(() => parseInviteUrl("https://trustedagents.link/connect")).toThrow(
			"missing required parameters",
		);

		expect(() => parseInviteUrl("https://trustedagents.link/connect?agentId=1")).toThrow(
			"missing required parameters",
		);
	});

	it("should throw for a URL with invalid expires", () => {
		expect(() =>
			parseInviteUrl(
				"https://trustedagents.link/connect?agentId=1&chain=eip155:1&expires=notanumber&sig=0xabc",
			),
		).toThrow("expires is not a number");
	});

	it("should throw for a signature not starting with 0x", () => {
		expect(() =>
			parseInviteUrl(
				"https://trustedagents.link/connect?agentId=1&chain=eip155:1&expires=9999999999&sig=abc",
			),
		).toThrow("signature must start with 0x");
	});
});

describe("verifyInvite", () => {
	it("should verify a valid invite", async () => {
		const { invite } = await generateInvite({
			agentId: 1,
			chain: "eip155:1",
			account: ALICE.account,
			expirySeconds: 3600,
		});

		const result = await verifyInvite(invite);

		expect(result.valid).toBe(true);
		expect(result.signerAddress.toLowerCase()).toBe(ALICE.address.toLowerCase());
	});

	it("should reject an expired invite", async () => {
		const { invite } = await generateInvite({
			agentId: 1,
			chain: "eip155:1",
			account: ALICE.account,
			expirySeconds: -10, // already expired
		});

		const result = await verifyInvite(invite);

		expect(result.valid).toBe(false);
		expect(result.error).toContain("expired");
	});

	it("should round-trip: generate then parse URL then verify", async () => {
		const { url } = await generateInvite({
			agentId: 5,
			chain: "eip155:137",
			account: ALICE.account,
		});

		const parsed = parseInviteUrl(url);
		const result = await verifyInvite(parsed);

		expect(result.valid).toBe(true);
		expect(result.signerAddress.toLowerCase()).toBe(ALICE.address.toLowerCase());
	});
});
