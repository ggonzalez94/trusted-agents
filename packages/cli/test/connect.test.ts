/**
 * Tests for `tap connect` after the Phase 3 refactor.
 *
 * The command is now a thin tapd HTTP client. It still owns the wait-flag
 * logic (--no-wait, --wait-seconds N, default 30s blocking) but the actual
 * connect work happens in tapd. These tests mock fetch to verify the wait
 * semantics survive the refactor.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, successMock, errorMock, infoMock, parseInviteUrlMock, isSelfInviteMock } =
	vi.hoisted(() => ({
		loadConfigMock: vi.fn(),
		successMock: vi.fn(),
		errorMock: vi.fn(),
		infoMock: vi.fn(),
		parseInviteUrlMock: vi.fn(() => ({
			agentId: 42,
			chain: "eip155:8453",
			expires: Math.floor(Date.now() / 1000) + 86400,
		})),
		isSelfInviteMock: vi.fn(() => false),
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
	return { ...actual, success: successMock, error: errorMock, info: infoMock };
});

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		parseInviteUrl: parseInviteUrlMock,
		isSelfInvite: isSelfInviteMock,
	};
});

import { connectCommand } from "../src/commands/connect.js";

const INVITE_URL = "tap://invite?data=abc123";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("tap connect (tapd client refactor)", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tap-connect-"));
		await writeFile(join(dataDir, ".tapd.port"), "4321", "utf-8");
		await writeFile(join(dataDir, ".tapd-token"), "token-xyz", "utf-8");
		loadConfigMock.mockResolvedValue({ dataDir, agentId: 1, chain: "eip155:8453" });
	});

	afterEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		process.exitCode = undefined;
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	});

	it("default: forwards waitMs=30000 and prints active on success", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				connectionId: "conn-abc",
				peerName: "Alice",
				peerAgentId: 42,
				status: "active",
				receipt: { messageId: "msg-1" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await connectCommand(INVITE_URL, { json: true }, undefined, false, false);

		expect(process.exitCode).toBeUndefined();
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string).waitMs).toBe(30_000);
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "active", connection_id: "conn-abc" }),
			expect.any(Object),
			expect.any(Number),
		);
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("default: exits 2 when tapd returns pending (blocking wait timed out)", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				connectionId: "conn-abc",
				peerName: "Alice",
				peerAgentId: 42,
				status: "pending",
				receipt: { messageId: "msg-1" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await connectCommand(INVITE_URL, { json: true }, undefined, false, false);

		expect(process.exitCode).toBe(2);
		expect(errorMock).toHaveBeenCalledWith(
			"TIMEOUT",
			expect.stringContaining("30s"),
			expect.any(Object),
		);
		expect(successMock).not.toHaveBeenCalled();
	});

	it("--no-wait: exits 0 immediately on pending", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				connectionId: "conn-abc",
				peerName: "Alice",
				peerAgentId: 42,
				status: "pending",
				receipt: { messageId: "msg-1" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await connectCommand(INVITE_URL, { json: true }, undefined, true, false);

		expect(process.exitCode).toBeUndefined();
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string).waitMs).toBe(0);
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending", connection_id: "conn-abc" }),
			expect.any(Object),
			expect.any(Number),
		);
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("--wait-seconds 0: equivalent to --no-wait", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				connectionId: "conn-abc",
				peerName: "Alice",
				peerAgentId: 42,
				status: "pending",
				receipt: { messageId: "msg-1" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await connectCommand(INVITE_URL, { json: true }, 0, false, false);

		expect(process.exitCode).toBeUndefined();
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending" }),
			expect.any(Object),
			expect.any(Number),
		);
	});

	it("--wait-seconds N: forwards N*1000 to tapd", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				connectionId: "conn-abc",
				peerName: "Alice",
				peerAgentId: 42,
				status: "active",
				receipt: { messageId: "msg-1" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await connectCommand(INVITE_URL, { json: true }, 120, false, false);

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string).waitMs).toBe(120_000);
	});

	it("--dry-run: previews without contacting tapd", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await connectCommand(INVITE_URL, { json: true }, undefined, false, true);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "preview", dry_run: true }),
			expect.any(Object),
			expect.any(Number),
		);
	});

	it("rejects self-invites with a validation error", async () => {
		isSelfInviteMock.mockReturnValueOnce(true);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await connectCommand(INVITE_URL, { json: true }, undefined, false, false);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(errorMock).toHaveBeenCalled();
		expect(successMock).not.toHaveBeenCalled();
	});

	it("cli flags: --no-wait registers in CLI and --yes is absent", async () => {
		const { createCli } = await import("../src/cli.js");
		const program = createCli();
		const connect = program.commands.find((cmd) => cmd.name() === "connect");
		expect(connect).toBeDefined();
		const helpText = connect?.helpInformation() ?? "";
		expect(helpText).toContain("--no-wait");
		expect(helpText).toContain("--wait-seconds");
		expect(helpText).not.toContain("--yes");
	});
});
