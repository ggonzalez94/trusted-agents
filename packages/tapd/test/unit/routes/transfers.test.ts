import { describe, expect, it, vi } from "vitest";
import { createTransfersRoute } from "../../../src/http/routes/transfers.js";

const validBody = {
	asset: "usdc" as const,
	amount: "1.50",
	chain: "eip155:8453",
	toAddress: "0x0000000000000000000000000000000000000000",
};

describe("transfers route", () => {
	it("delegates to the executor and returns txHash", async () => {
		const executor = vi.fn(async () => ({ txHash: "0xabc" as const }));
		const handler = createTransfersRoute(executor);

		const result = await handler({}, validBody);

		expect(executor).toHaveBeenCalledOnce();
		expect(executor.mock.calls[0]?.[0]).toEqual(validBody);
		expect(result).toEqual({ txHash: "0xabc" });
	});

	it("rejects bodies with invalid asset", async () => {
		const executor = vi.fn(async () => ({ txHash: "0xabc" as const }));
		const handler = createTransfersRoute(executor);
		await expect(handler({}, { ...validBody, asset: "eth" })).rejects.toThrow();
	});

	it("rejects bodies with non-hex toAddress", async () => {
		const executor = vi.fn(async () => ({ txHash: "0xabc" as const }));
		const handler = createTransfersRoute(executor);
		await expect(handler({}, { ...validBody, toAddress: "alice.eth" })).rejects.toThrow();
	});

	it("rejects empty body", async () => {
		const executor = vi.fn(async () => ({ txHash: "0xabc" as const }));
		const handler = createTransfersRoute(executor);
		await expect(handler({}, undefined)).rejects.toThrow();
	});
});
