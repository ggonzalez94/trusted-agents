import { describe, expect, it, vi } from "vitest";
import { createMessagesRoute } from "../../../src/http/routes/messages.js";

interface FakeService {
	sendMessage: ReturnType<typeof vi.fn>;
}

function makeService(): FakeService {
	return {
		sendMessage: vi.fn(async (peer: string, _text: string, scope?: string) => ({
			receipt: { messageId: "msg-1", status: "delivered" as const },
			peerName: `peer-${peer}`,
			peerAgentId: 42,
			scope: scope ?? "general-chat",
		})),
	};
}

describe("messages route", () => {
	it("forwards peer, text, and scope to the service", async () => {
		const service = makeService();
		const handler = createMessagesRoute(service as never);

		const result = (await handler({}, { peer: "bob", text: "hi", scope: "default" })) as {
			peerName: string;
			scope: string;
		};

		expect(service.sendMessage).toHaveBeenCalledOnce();
		const args = service.sendMessage.mock.calls[0];
		expect(args[0]).toBe("bob");
		expect(args[1]).toBe("hi");
		expect(args[2]).toBe("default");
		expect(result.peerName).toBe("peer-bob");
		expect(result.scope).toBe("default");
	});

	it("omits scope when not provided", async () => {
		const service = makeService();
		const handler = createMessagesRoute(service as never);

		await handler({}, { peer: "bob", text: "hi" });
		const args = service.sendMessage.mock.calls[0];
		expect(args[2]).toBeUndefined();
	});

	it("rejects requests missing peer", async () => {
		const service = makeService();
		const handler = createMessagesRoute(service as never);

		await expect(handler({}, { text: "hi" })).rejects.toThrow(/peer/);
	});

	it("rejects requests missing text", async () => {
		const service = makeService();
		const handler = createMessagesRoute(service as never);

		await expect(handler({}, { peer: "bob" })).rejects.toThrow(/text/);
	});

	it("rejects empty bodies", async () => {
		const service = makeService();
		const handler = createMessagesRoute(service as never);

		await expect(handler({}, undefined)).rejects.toThrow();
	});
});
