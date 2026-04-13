import { describe, expect, it, vi } from "vitest";
import { createTapGatewayTool } from "../src/tool.js";

describe("createTapGatewayTool", () => {
	it("returns JSON results for successful actions", async () => {
		const registry = {
			status: vi.fn(async () => ({ configured: true })),
		};
		const tool = createTapGatewayTool(registry as never);

		const result = await tool.execute?.("call-1", { action: "status" });

		expect(registry.status).toHaveBeenCalledWith(undefined);
		expect(result?.details).toEqual({ configured: true });
	});

	it("throws tool errors instead of flattening them into success payloads", async () => {
		const registry = {
			status: vi.fn(async () => ({ configured: true })),
		};
		const tool = createTapGatewayTool(registry as never);

		await expect(tool.execute?.("call-1", { action: "send_message" })).rejects.toThrow(
			"peer is required",
		);
	});

	it("rejects non-numeric transfer amounts before reaching the registry", async () => {
		const transfer = vi.fn();
		const registry = { transfer };
		const tool = createTapGatewayTool(registry as never);

		await expect(
			tool.execute?.("call-1", {
				action: "transfer",
				asset: "usdc",
				amount: "abc",
				toAddress: "0x1111111111111111111111111111111111111111",
			}),
		).rejects.toThrow("amount must be a positive number");
		expect(transfer).not.toHaveBeenCalled();
	});

	it("rejects non-positive transfer amounts before reaching the registry", async () => {
		const transfer = vi.fn();
		const registry = { transfer };
		const tool = createTapGatewayTool(registry as never);

		await expect(
			tool.execute?.("call-1", {
				action: "transfer",
				asset: "usdc",
				amount: "-1",
				toAddress: "0x1111111111111111111111111111111111111111",
			}),
		).rejects.toThrow("amount must be a positive number");
		expect(transfer).not.toHaveBeenCalled();
	});

	it("accepts well-formed decimal amounts", async () => {
		const transfer = vi.fn(async () => ({
			identity: "default",
			status: "submitted" as const,
			asset: "usdc",
			amount: "0.5",
			chain: "eip155:8453",
			to_address: "0x1111111111111111111111111111111111111111",
			tx_hash: "0xdeadbeef",
		}));
		const registry = { transfer };
		const tool = createTapGatewayTool(registry as never);

		await tool.execute?.("call-1", {
			action: "transfer",
			asset: "usdc",
			amount: "0.5",
			toAddress: "0x1111111111111111111111111111111111111111",
		});

		expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amount: "0.5" }));
	});
});
