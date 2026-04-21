import { describe, expect, it, vi } from "vitest";
import { createInvitesRoute } from "../../../src/http/routes/invites.js";

describe("invites route", () => {
	it("delegates to the creator and returns the invite URL", async () => {
		const creator = vi.fn(async () => ({
			url: "https://trustedagents.link/connect?agentId=1&chain=eip155%3A8453&expires=123&sig=0xabc",
			expiresInSeconds: 3600,
		}));
		const handler = createInvitesRoute(creator);

		const result = await handler({}, { expiresInSeconds: 3600 });

		expect(creator).toHaveBeenCalledOnce();
		expect(creator.mock.calls[0]?.[0]).toEqual({ expiresInSeconds: 3600 });
		expect(result).toEqual({
			url: "https://trustedagents.link/connect?agentId=1&chain=eip155%3A8453&expires=123&sig=0xabc",
			expiresInSeconds: 3600,
		});
	});

	it("accepts an empty body and forwards undefined expiresInSeconds", async () => {
		const creator = vi.fn(async () => ({
			url: "https://trustedagents.link/connect?agentId=1&chain=eip155%3A8453&expires=999&sig=0xabc",
			expiresInSeconds: 3600,
		}));
		const handler = createInvitesRoute(creator);

		const result = await handler({}, undefined);

		expect(creator).toHaveBeenCalledOnce();
		expect(creator.mock.calls[0]?.[0]).toEqual({});
		expect(result.url).toContain("trustedagents.link/connect");
	});

	it("rejects bodies with non-positive expiresInSeconds", async () => {
		const creator = vi.fn(async () => ({
			url: "https://trustedagents.link/connect?agentId=1&chain=eip155%3A8453&expires=1&sig=0xabc",
			expiresInSeconds: 1,
		}));
		const handler = createInvitesRoute(creator);

		await expect(handler({}, { expiresInSeconds: 0 })).rejects.toThrow();
		await expect(handler({}, { expiresInSeconds: -10 })).rejects.toThrow();
	});

	it("rejects bodies with non-number expiresInSeconds", async () => {
		const creator = vi.fn(async () => ({
			url: "https://trustedagents.link/connect?agentId=1&chain=eip155%3A8453&expires=1&sig=0xabc",
			expiresInSeconds: 1,
		}));
		const handler = createInvitesRoute(creator);

		await expect(handler({}, { expiresInSeconds: "3600" })).rejects.toThrow();
	});
});
