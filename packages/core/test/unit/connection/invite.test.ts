import { describe, expect, it } from "vitest";
import { generateInvite } from "../../../src/connection/invite.js";
import { ALICE } from "../../fixtures/test-keys.js";

describe("generateInvite", () => {
	it("should generate an invite with a valid URL", async () => {
		const { url } = await generateInvite({
			agentId: 1,
			chain: "eip155:1",
			privateKey: ALICE.privateKey,
		});

		expect(url).toContain("https://trustedagents.link/connect");
		expect(url).toContain("agentId=1");
		expect(url).toContain("chain=eip155");
		expect(url).toContain("nonce=");
		expect(url).toContain("expires=");
		expect(url).toContain("sig=0x");
	});

	it("should return invite data with all required fields", async () => {
		const { invite } = await generateInvite({
			agentId: 42,
			chain: "eip155:137",
			privateKey: ALICE.privateKey,
			expirySeconds: 7200,
		});

		expect(invite.agentId).toBe(42);
		expect(invite.chain).toBe("eip155:137");
		expect(invite.nonce).toBeDefined();
		expect(invite.nonce.length).toBeGreaterThan(0);
		expect(invite.expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
		expect(invite.signature).toMatch(/^0x/);
	});

	it("should use default expiry of 3600 seconds", async () => {
		const now = Math.floor(Date.now() / 1000);
		const { invite } = await generateInvite({
			agentId: 1,
			chain: "eip155:1",
			privateKey: ALICE.privateKey,
		});

		// Should expire approximately 3600 seconds from now (allow 5s tolerance)
		expect(invite.expires).toBeGreaterThanOrEqual(now + 3595);
		expect(invite.expires).toBeLessThanOrEqual(now + 3605);
	});

	it("should generate unique nonces for each invite", async () => {
		const { invite: invite1 } = await generateInvite({
			agentId: 1,
			chain: "eip155:1",
			privateKey: ALICE.privateKey,
		});

		const { invite: invite2 } = await generateInvite({
			agentId: 1,
			chain: "eip155:1",
			privateKey: ALICE.privateKey,
		});

		expect(invite1.nonce).not.toBe(invite2.nonce);
	});
});
