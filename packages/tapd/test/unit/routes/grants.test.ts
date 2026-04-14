import { describe, expect, it, vi } from "vitest";
import { createGrantsRoutes } from "../../../src/http/routes/grants.js";

const grantSet = {
	updatedAt: "2026-04-13T00:00:00Z",
	grants: [
		{
			grantId: "g-1",
			scope: "transfer/request",
			status: "active" as const,
			updatedAt: "2026-04-13T00:00:00Z",
		},
	],
};

function makeService() {
	return {
		publishGrantSet: vi.fn(async (peer: string, set: typeof grantSet) => ({
			receipt: { messageId: "m-1", status: "delivered" as const },
			peerName: peer,
			peerAgentId: 99,
			grantCount: set.grants.length,
		})),
		requestGrantSet: vi.fn(async (peer: string, set: typeof grantSet) => ({
			receipt: { messageId: "m-2", status: "delivered" as const },
			actionId: "act-1",
			peerName: peer,
			peerAgentId: 99,
			grantCount: set.grants.length,
		})),
	};
}

describe("grants routes", () => {
	it("publish forwards to publishGrantSet with note", async () => {
		const service = makeService();
		const { publish } = createGrantsRoutes(service as never);

		const result = await publish({}, { peer: "Alice", grantSet, note: "test" });

		expect(service.publishGrantSet).toHaveBeenCalledWith("Alice", grantSet, "test");
		expect(result.peerName).toBe("Alice");
		expect(result.grantCount).toBe(1);
	});

	it("request forwards to requestGrantSet", async () => {
		const service = makeService();
		const { request } = createGrantsRoutes(service as never);

		const result = await request({}, { peer: "Alice", grantSet });

		expect(service.requestGrantSet).toHaveBeenCalledWith("Alice", grantSet, undefined);
		expect(result.actionId).toBe("act-1");
	});

	it("publish rejects bodies missing peer", async () => {
		const { publish } = createGrantsRoutes(makeService() as never);
		await expect(publish({}, { grantSet })).rejects.toThrow();
	});

	it("publish rejects bodies missing grantSet", async () => {
		const { publish } = createGrantsRoutes(makeService() as never);
		await expect(publish({}, { peer: "Alice" })).rejects.toThrow();
	});
});
