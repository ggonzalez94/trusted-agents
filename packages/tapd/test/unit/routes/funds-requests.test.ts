import { describe, expect, it, vi } from "vitest";
import { createFundsRequestsRoute } from "../../../src/http/routes/funds-requests.js";

function makeService() {
	return {
		requestFunds: vi.fn(async (input: { peer: string; asset: string; amount: string }) => ({
			receipt: { messageId: "msg-1", status: "delivered" as const },
			actionId: "act-1",
			peerName: input.peer,
			peerAgentId: 99,
			asset: input.asset as "native" | "usdc",
			amount: input.amount,
			chain: "eip155:8453",
			toAddress: "0x0000000000000000000000000000000000000000" as const,
		})),
	};
}

const validBody = {
	peer: "Alice",
	asset: "usdc" as const,
	amount: "1.50",
	chain: "eip155:8453",
	toAddress: "0x0000000000000000000000000000000000000000",
	note: "lunch",
};

describe("funds-requests route", () => {
	it("forwards a valid input to service.requestFunds", async () => {
		const service = makeService();
		const handler = createFundsRequestsRoute(service as never);

		const result = await handler({}, validBody);

		expect(service.requestFunds).toHaveBeenCalledOnce();
		expect(service.requestFunds.mock.calls[0]?.[0]).toEqual(validBody);
		expect(result.peerName).toBe("Alice");
		expect(result.actionId).toBe("act-1");
	});

	it("rejects bodies missing required fields", async () => {
		const handler = createFundsRequestsRoute(makeService() as never);
		await expect(handler({}, { peer: "Alice", asset: "usdc" })).rejects.toThrow();
	});

	it("rejects bodies with invalid asset", async () => {
		const handler = createFundsRequestsRoute(makeService() as never);
		await expect(handler({}, { ...validBody, asset: "eth" })).rejects.toThrow();
	});

	it("rejects toAddress that is not an 0x-prefixed string", async () => {
		const handler = createFundsRequestsRoute(makeService() as never);
		await expect(handler({}, { ...validBody, toAddress: "alice.eth" })).rejects.toThrow();
	});
});
