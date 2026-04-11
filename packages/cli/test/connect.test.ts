/**
 * Tests for `tap connect` — verifies the new 4.3 behavior:
 * - Default: blocks up to 30s; exits 0 on active, exits 2 on timeout
 * - --no-wait: exits 0 immediately with status pending
 * - --wait-seconds 0: equivalent to --no-wait
 * - No --yes flag / no prompt is shown
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const {
	loadConfigMock,
	createCliRuntimeMock,
	runOrQueueTapCommandMock,
	successMock,
	errorMock,
	infoMock,
	parseInviteUrlMock,
	verifyInviteMock,
	isSelfInviteMock,
} = vi.hoisted(() => ({
	loadConfigMock: vi.fn(async () => ({
		chain: "eip155:8453",
		agentId: 1,
		dataDir: "/tmp/tap-test",
	})),
	createCliRuntimeMock: vi.fn(),
	runOrQueueTapCommandMock: vi.fn(),
	successMock: vi.fn(),
	errorMock: vi.fn(),
	infoMock: vi.fn(),
	parseInviteUrlMock: vi.fn(() => ({
		agentId: 42,
		chain: "eip155:8453",
		expires: Math.floor(Date.now() / 1000) + 86400,
	})),
	verifyInviteMock: vi.fn(async () => ({ valid: true })),
	isSelfInviteMock: vi.fn(() => false),
}));

vi.mock("../src/lib/config-loader.js", () => ({
	loadConfig: loadConfigMock,
}));

vi.mock("../src/lib/cli-runtime.js", () => ({
	createCliRuntime: createCliRuntimeMock,
}));

vi.mock("../src/lib/queued-commands.js", () => ({
	runOrQueueTapCommand: runOrQueueTapCommandMock,
	isQueuedTapCommandPending: (outcome: { status: string }) => outcome.status === "queued",
	queuedTapCommandPendingFields: (outcome: { jobId: string; owner?: unknown }) => ({
		queued: true,
		job_id: outcome.jobId,
		owner: outcome.owner,
	}),
	queuedTapCommandResultFields: (outcome: { queued: boolean; status: string; jobId?: string }) => ({
		queued: outcome.queued,
		job_id: outcome.status === "completed" ? outcome.jobId : undefined,
	}),
}));

vi.mock("../src/lib/output.js", () => ({
	success: successMock,
	error: errorMock,
	info: infoMock,
}));

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		parseInviteUrl: parseInviteUrlMock,
		verifyInvite: verifyInviteMock,
		isSelfInvite: isSelfInviteMock,
		caip2ToChainId: () => 8453,
	};
});

import { connectCommand } from "../src/commands/connect.js";

const INVITE_URL = "tap://invite?data=abc123";

const PEER_AGENT = {
	agentId: 42,
	chain: "eip155:8453",
	agentAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	registrationFile: { name: "Alice" },
	capabilities: ["messaging"],
};

const OPTS = { json: true };

function buildRuntime(connectFn: () => Promise<unknown>) {
	return {
		resolver: {
			resolve: vi.fn(async () => PEER_AGENT),
		},
		trustStore: {
			getContacts: vi.fn(async () => []),
		},
		service: {
			connect: connectFn,
		},
		// Required for the try/finally cleanup in connectCommand — releases the
		// transport owner lock when the command exits.
		stop: vi.fn(async () => {}),
	};
}

describe("tap connect", () => {
	afterEach(() => {
		vi.clearAllMocks();
		process.exitCode = undefined;
	});

	it("default: exits 0 when service returns active within 30s", async () => {
		const activeResult = {
			connectionId: "conn-abc",
			peerName: "Alice",
			peerAgentId: 42,
			status: "active" as const,
			receipt: { messageId: "msg-1" },
		};

		createCliRuntimeMock.mockResolvedValue(buildRuntime(async () => activeResult));
		runOrQueueTapCommandMock.mockImplementation(async (_dir, _job, run) => ({
			status: "executed",
			result: await run(),
			queued: false,
		}));

		await connectCommand(INVITE_URL, OPTS, undefined, false, false);

		expect(process.exitCode).toBeUndefined();
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "active", connection_id: "conn-abc" }),
			OPTS,
			expect.any(Number),
		);
		expect(errorMock).not.toHaveBeenCalled();
		expect(runOrQueueTapCommandMock).toHaveBeenCalledWith(
			"/tmp/tap-test",
			expect.objectContaining({ type: "connect" }),
			expect.any(Function),
			expect.objectContaining({ requestedBy: "tap:connect" }),
		);
	});

	it("default: exits 2 when service returns pending (30s wait timed out)", async () => {
		const pendingResult = {
			connectionId: "conn-abc",
			peerName: "Alice",
			peerAgentId: 42,
			status: "pending" as const,
			receipt: { messageId: "msg-1" },
		};

		createCliRuntimeMock.mockResolvedValue(buildRuntime(async () => pendingResult));
		runOrQueueTapCommandMock.mockImplementation(async (_dir, _job, run) => ({
			status: "executed",
			result: await run(),
			queued: false,
		}));

		await connectCommand(INVITE_URL, OPTS, undefined, false, false);

		expect(process.exitCode).toBe(2);
		expect(errorMock).toHaveBeenCalledWith("TIMEOUT", expect.stringContaining("30s"), OPTS);
		expect(successMock).not.toHaveBeenCalled();
	});

	it("--no-wait: exits 0 immediately when service returns pending", async () => {
		const pendingResult = {
			connectionId: "conn-abc",
			peerName: "Alice",
			peerAgentId: 42,
			status: "pending" as const,
			receipt: { messageId: "msg-1" },
		};

		createCliRuntimeMock.mockResolvedValue(buildRuntime(async () => pendingResult));
		runOrQueueTapCommandMock.mockImplementation(async (_dir, _job, run) => ({
			status: "executed",
			result: await run(),
			queued: false,
		}));

		await connectCommand(INVITE_URL, OPTS, undefined, true /* noWait */, false);

		expect(process.exitCode).toBeUndefined();
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending", connection_id: "conn-abc" }),
			OPTS,
			expect.any(Number),
		);
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("--wait-seconds 0: exits 0 immediately (equivalent to --no-wait)", async () => {
		const pendingResult = {
			connectionId: "conn-abc",
			peerName: "Alice",
			peerAgentId: 42,
			status: "pending" as const,
			receipt: { messageId: "msg-1" },
		};

		createCliRuntimeMock.mockResolvedValue(buildRuntime(async () => pendingResult));
		runOrQueueTapCommandMock.mockImplementation(async (_dir, _job, run) => ({
			status: "executed",
			result: await run(),
			queued: false,
		}));

		// waitSeconds=0, noWait=false — zero wait-seconds is treated as no-wait
		await connectCommand(INVITE_URL, OPTS, 0 /* waitSeconds */, false, false);

		expect(process.exitCode).toBeUndefined();
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending" }),
			OPTS,
			expect.any(Number),
		);
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("no --yes flag: no prompt is called when service returns active", async () => {
		const activeResult = {
			connectionId: "conn-abc",
			peerName: "Alice",
			peerAgentId: 42,
			status: "active" as const,
			receipt: { messageId: "msg-1" },
		};

		createCliRuntimeMock.mockResolvedValue(buildRuntime(async () => activeResult));
		runOrQueueTapCommandMock.mockImplementation(async (_dir, _job, run) => ({
			status: "executed",
			result: await run(),
			queued: false,
		}));

		// Run with no stdin TTY (non-interactive). Should NOT fail or prompt.
		const origIsTTY = process.stdin.isTTY;
		try {
			// @ts-expect-error — intentionally overriding for test
			process.stdin.isTTY = false;
			await connectCommand(INVITE_URL, OPTS, undefined, false, false);
		} finally {
			// @ts-expect-error — restoring
			process.stdin.isTTY = origIsTTY;
		}

		// No VALIDATION_ERROR about --yes or interactive prompt
		expect(errorMock).not.toHaveBeenCalledWith("VALIDATION_ERROR", expect.any(String), OPTS);
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "active" }),
			OPTS,
			expect.any(Number),
		);
	});

	it("--wait-seconds N: passes N*1000 as waitMs to service.connect", async () => {
		const activeResult = {
			connectionId: "conn-abc",
			peerName: "Alice",
			peerAgentId: 42,
			status: "active" as const,
			receipt: { messageId: "msg-1" },
		};

		let capturedWaitMs: number | undefined;
		const connectFn = vi.fn(async ({ waitMs }: { inviteUrl: string; waitMs: number }) => {
			capturedWaitMs = waitMs;
			return activeResult;
		});

		createCliRuntimeMock.mockResolvedValue(buildRuntime(connectFn as never));
		runOrQueueTapCommandMock.mockImplementation(async (_dir, _job, run) => ({
			status: "executed",
			result: await run(),
			queued: false,
		}));

		await connectCommand(INVITE_URL, OPTS, 120 /* waitSeconds */, false, false);

		expect(capturedWaitMs).toBe(120_000);
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: "active" }),
			OPTS,
			expect.any(Number),
		);
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
