import { describe, expect, it, vi } from "vitest";
import { createConnectRoute } from "../../../src/http/routes/connect.js";

function makeService() {
	return {
		connect: vi.fn(async (params: { inviteUrl: string; waitMs?: number }) => ({
			connectionId: "conn-1",
			peerName: "Alice",
			peerAgentId: 42,
			status: params.waitMs === 0 ? ("pending" as const) : ("active" as const),
			receipt: { messageId: "msg-1", status: "delivered" as const },
		})),
	};
}

describe("connect route", () => {
	it("forwards inviteUrl and waitMs to service.connect", async () => {
		const service = makeService();
		const handler = createConnectRoute(service as never);

		const result = await handler({}, { inviteUrl: "tap://invite/abc", waitMs: 5000 });

		expect(service.connect).toHaveBeenCalledOnce();
		expect(service.connect.mock.calls[0]?.[0]).toEqual({
			inviteUrl: "tap://invite/abc",
			waitMs: 5000,
		});
		expect(result.status).toBe("active");
	});

	it("treats waitMs=0 as fire-and-forget (returns pending)", async () => {
		const service = makeService();
		const handler = createConnectRoute(service as never);

		const result = await handler({}, { inviteUrl: "tap://invite/abc", waitMs: 0 });
		expect(result.status).toBe("pending");
	});

	it("rejects bodies missing inviteUrl", async () => {
		const handler = createConnectRoute(makeService() as never);
		await expect(handler({}, {})).rejects.toThrow(/inviteUrl/);
	});

	it("rejects bodies with non-numeric waitMs", async () => {
		const handler = createConnectRoute(makeService() as never);
		await expect(handler({}, { inviteUrl: "tap://x", waitMs: "5000" })).rejects.toThrow();
	});
});
