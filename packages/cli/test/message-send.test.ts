/**
 * Unit tests for `tap message send` after the Phase 3 refactor and the
 * Unix-socket migration. The command is now a thin tapd HTTP client over
 * `<dataDir>/.tapd.sock` — these tests stand up a fake tapd-shaped socket
 * server and verify the client posts the right body and the success
 * payload preserves the historical JSON shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FAKE_TAPD_TOKEN,
	FakeError,
	type FakeTapdHandle,
	startFakeTapd,
} from "./helpers/fake-tapd-socket.ts";

const { loadConfigMock, successMock, errorMock } = vi.hoisted(() => ({
	loadConfigMock: vi.fn(),
	successMock: vi.fn(),
	errorMock: vi.fn(),
}));

vi.mock("../src/lib/config-loader.js", async () => {
	const actual = await vi.importActual<typeof import("../src/lib/config-loader.js")>(
		"../src/lib/config-loader.js",
	);
	return { ...actual, loadConfig: loadConfigMock };
});

vi.mock("../src/lib/output.js", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/output.js")>("../src/lib/output.js");
	return { ...actual, success: successMock, error: errorMock };
});

import { messageSendCommand } from "../src/commands/message-send.js";

describe("tap message send (tapd client refactor)", () => {
	let fake: FakeTapdHandle;

	beforeEach(async () => {
		// Each test sets `fake` to a fresh server in `makeFake`.
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await fake?.stop();
	});

	async function makeFake(routes: Parameters<typeof startFakeTapd>[0]["routes"]): Promise<void> {
		fake = await startFakeTapd({ routes });
		loadConfigMock.mockResolvedValue({ dataDir: fake.dataDir });
	}

	it("POSTs to /api/messages and emits the legacy success payload", async () => {
		await makeFake([
			{
				method: "POST",
				path: "/api/messages",
				handler: () => ({
					receipt: { messageId: "m-1", status: "delivered" },
					peerName: "Alice",
					peerAgentId: 99,
					scope: "general-chat",
				}),
			},
		]);

		await messageSendCommand("Alice", "hello", { json: true });

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]).toMatchObject({
			method: "POST",
			path: "/api/messages",
			authHeader: `Bearer ${FAKE_TAPD_TOKEN}`,
			body: { peer: "Alice", text: "hello", scope: "general-chat" },
		});

		expect(successMock).toHaveBeenCalledOnce();
		const payload = successMock.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload).toMatchObject({
			sent: true,
			peer: "Alice",
			agent_id: 99,
			scope: "general-chat",
			receipt: { messageId: "m-1", status: "delivered" },
		});
	});

	it("forwards an explicit --scope to the tapd POST body", async () => {
		await makeFake([
			{
				method: "POST",
				path: "/api/messages",
				handler: () => ({
					receipt: { messageId: "m-1", status: "delivered" },
					peerName: "Alice",
					peerAgentId: 99,
					scope: "design-review",
				}),
			},
		]);

		await messageSendCommand("Alice", "looks good", { json: true }, { scope: "design-review" });

		const body = fake.calls[0]?.body as { scope: string };
		expect(body.scope).toBe("design-review");
	});

	it("surfaces errors via handleCommandError when tapd returns 4xx", async () => {
		await makeFake([
			{
				method: "POST",
				path: "/api/messages",
				handler: () => new FakeError(400, "validation_error", "missing peer"),
			},
		]);

		await messageSendCommand("Alice", "hello", { json: true });
		expect(errorMock).toHaveBeenCalledOnce();
		expect(successMock).not.toHaveBeenCalled();
	});
});
