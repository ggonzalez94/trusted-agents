/**
 * Tests for `tap connect` after the Phase 3 refactor and the Unix-socket
 * migration.
 *
 * The command is now a thin tapd HTTP-over-Unix-socket client. It still
 * owns the wait-flag logic (--no-wait, --wait-seconds N, default 30s
 * blocking) but the actual connect work happens in tapd. These tests stand
 * up a fake tapd-shaped socket server to verify the wait semantics survive
 * the refactor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeTapdHandle, startFakeTapd } from "./helpers/fake-tapd-socket.ts";

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

describe("tap connect (tapd client refactor)", () => {
	let fake: FakeTapdHandle | null;

	beforeEach(async () => {
		fake = null;
		// Tests that don't actually call tapd (dry-run, self-invite) still
		// need loadConfig to resolve to *some* dataDir; the connect command
		// short-circuits before talking to tapd in those paths.
		loadConfigMock.mockResolvedValue({
			dataDir: "/tmp/tap-connect-validation-stub",
			agentId: 1,
			chain: "eip155:8453",
		});
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await fake?.stop();
		process.exitCode = undefined;
	});

	/** Spin up a fake tapd socket and wire loadConfig to its dataDir. */
	async function withFakeTapd(
		routes: Parameters<typeof startFakeTapd>[0]["routes"],
	): Promise<void> {
		fake = await startFakeTapd({ routes });
		loadConfigMock.mockResolvedValue({
			dataDir: fake.dataDir,
			agentId: 1,
			chain: "eip155:8453",
		});
	}

	it("default: forwards waitMs=30000 and prints active on success", async () => {
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/connect",
				handler: () => ({
					connectionId: "conn-abc",
					peerName: "Alice",
					peerAgentId: 42,
					status: "active",
					receipt: { messageId: "msg-1" },
				}),
			},
		]);

		await connectCommand(INVITE_URL, { json: true }, undefined, false, false);

		expect(process.exitCode).toBeUndefined();
		const body = fake?.calls[0]?.body as { waitMs: number };
		expect(body.waitMs).toBe(30_000);
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "active", connection_id: "conn-abc" }),
			expect.any(Object),
			expect.any(Number),
		);
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("default: exits 2 when tapd returns pending (blocking wait timed out)", async () => {
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/connect",
				handler: () => ({
					connectionId: "conn-abc",
					peerName: "Alice",
					peerAgentId: 42,
					status: "pending",
					receipt: { messageId: "msg-1" },
				}),
			},
		]);

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
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/connect",
				handler: () => ({
					connectionId: "conn-abc",
					peerName: "Alice",
					peerAgentId: 42,
					status: "pending",
					receipt: { messageId: "msg-1" },
				}),
			},
		]);

		await connectCommand(INVITE_URL, { json: true }, undefined, true, false);

		expect(process.exitCode).toBeUndefined();
		const body = fake?.calls[0]?.body as { waitMs: number };
		expect(body.waitMs).toBe(0);
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending", connection_id: "conn-abc" }),
			expect.any(Object),
			expect.any(Number),
		);
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("--wait-seconds 0: equivalent to --no-wait", async () => {
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/connect",
				handler: () => ({
					connectionId: "conn-abc",
					peerName: "Alice",
					peerAgentId: 42,
					status: "pending",
					receipt: { messageId: "msg-1" },
				}),
			},
		]);

		await connectCommand(INVITE_URL, { json: true }, 0, false, false);

		expect(process.exitCode).toBeUndefined();
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending" }),
			expect.any(Object),
			expect.any(Number),
		);
	});

	it("--wait-seconds N: forwards N*1000 to tapd", async () => {
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/connect",
				handler: () => ({
					connectionId: "conn-abc",
					peerName: "Alice",
					peerAgentId: 42,
					status: "active",
					receipt: { messageId: "msg-1" },
				}),
			},
		]);

		await connectCommand(INVITE_URL, { json: true }, 120, false, false);

		const body = fake?.calls[0]?.body as { waitMs: number };
		expect(body.waitMs).toBe(120_000);
	});

	it("--dry-run: previews without contacting tapd", async () => {
		await connectCommand(INVITE_URL, { json: true }, undefined, false, true);

		expect(fake).toBeNull();
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "preview", dry_run: true }),
			expect.any(Object),
			expect.any(Number),
		);
	});

	it("rejects self-invites with a validation error", async () => {
		isSelfInviteMock.mockReturnValueOnce(true);

		await connectCommand(INVITE_URL, { json: true }, undefined, false, false);

		expect(fake).toBeNull();
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
