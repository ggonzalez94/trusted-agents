import { describe, expect, it } from "vitest";
import { createIdentityRoute } from "../../../src/http/routes/identity.js";

describe("identity route", () => {
	it("returns identity info from the provided source", async () => {
		const handler = createIdentityRoute(() => ({
			agentId: 42,
			chain: "eip155:8453",
			address: "0xabc",
			displayName: "Alice",
			dataDir: "/tmp/x",
		}));

		const result = await handler({}, undefined);
		expect(result).toEqual({
			agentId: 42,
			chain: "eip155:8453",
			address: "0xabc",
			displayName: "Alice",
			dataDir: "/tmp/x",
		});
	});
});
