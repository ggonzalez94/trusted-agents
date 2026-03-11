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
});
