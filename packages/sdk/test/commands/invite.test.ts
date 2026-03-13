import { describe, expect, it } from "vitest";
import { executeInvite } from "../../src/commands/invite.js";

describe("executeInvite", () => {
	const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

	it("should generate an invite with a valid URL", async () => {
		const result = await executeInvite({
			privateKey,
			agentId: 1,
			chain: "base-sepolia",
		});

		expect(result.url).toContain("https://trustedagents.link/connect");
		expect(result.url).toContain("agentId=1");
		expect(result.url).toContain("chain=base-sepolia");
		expect(result.url).toContain("sig=0x");
		expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("should respect custom expiry seconds", async () => {
		const result = await executeInvite({
			privateKey,
			agentId: 1,
			chain: "base-sepolia",
			expirySeconds: 7200,
		});

		const expiresAt = new Date(result.expiresAt).getTime();
		const now = Date.now();
		const diffSeconds = (expiresAt - now) / 1000;

		expect(diffSeconds).toBeGreaterThan(7100);
		expect(diffSeconds).toBeLessThan(7300);
	});

	it("should generate different invite URLs when the expiry changes", async () => {
		const result1 = await executeInvite({
			privateKey,
			agentId: 1,
			chain: "base-sepolia",
			expirySeconds: 3600,
		});

		const result2 = await executeInvite({
			privateKey,
			agentId: 1,
			chain: "base-sepolia",
			expirySeconds: 7200,
		});

		expect(result1.url).not.toBe(result2.url);
	});
});
