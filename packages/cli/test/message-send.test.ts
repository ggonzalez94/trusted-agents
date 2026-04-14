/**
 * Unit tests for `tap message send` after the Phase 3 refactor.
 * The command is now a thin tapd HTTP client — these tests mock fetch and
 * verify the client posts the right body and the success payload preserves
 * the historical JSON shape.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tap-msg-send-"));
		await writeFile(join(dataDir, ".tapd.port"), "4321", "utf-8");
		await writeFile(join(dataDir, ".tapd-token"), "token-xyz", "utf-8");
		loadConfigMock.mockResolvedValue({ dataDir });
	});

	afterEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	});

	it("POSTs to /api/messages and emits the legacy success payload", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						receipt: { messageId: "m-1", status: "delivered" },
						peerName: "Alice",
						peerAgentId: 99,
						scope: "general-chat",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await messageSendCommand("Alice", "hello", { json: true });

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:4321/api/messages");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-xyz");
		expect(JSON.parse(init.body as string)).toEqual({
			peer: "Alice",
			text: "hello",
			scope: "general-chat",
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
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						receipt: { messageId: "m-1", status: "delivered" },
						peerName: "Alice",
						peerAgentId: 99,
						scope: "design-review",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await messageSendCommand("Alice", "looks good", { json: true }, { scope: "design-review" });

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string).scope).toBe("design-review");
	});

	it("surfaces errors via handleCommandError when tapd returns 4xx", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ error: { code: "validation_error", message: "missing peer" } }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await messageSendCommand("Alice", "hello", { json: true });
		expect(errorMock).toHaveBeenCalledOnce();
		expect(successMock).not.toHaveBeenCalled();
	});
});
