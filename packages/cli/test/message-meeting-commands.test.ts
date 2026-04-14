/**
 * Tests for `tap message respond-meeting` and `tap message cancel-meeting`
 * after the Phase 3 refactor — both are tapd HTTP clients now.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, successMock, errorMock, verboseMock } = vi.hoisted(() => ({
	loadConfigMock: vi.fn(),
	successMock: vi.fn(),
	errorMock: vi.fn(),
	verboseMock: vi.fn(),
}));

vi.mock("../src/lib/config-loader.js", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/config-loader.js")>(
			"../src/lib/config-loader.js",
		);
	return { ...actual, loadConfig: loadConfigMock };
});

vi.mock("../src/lib/output.js", async () => {
	const actual = await vi.importActual<typeof import("../src/lib/output.js")>("../src/lib/output.js");
	return { ...actual, success: successMock, error: errorMock, verbose: verboseMock };
});

import { messageCancelMeetingCommand } from "../src/commands/message-cancel-meeting.js";
import { messageRespondMeetingCommand } from "../src/commands/message-respond-meeting.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("meeting CLI commands (tapd client refactor)", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "tap-meet-"));
		await writeFile(join(dataDir, ".tapd.port"), "4321", "utf-8");
		await writeFile(join(dataDir, ".tapd-token"), "token-xyz", "utf-8");
		loadConfigMock.mockResolvedValue({ dataDir });
	});

	afterEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
		process.exitCode = 0;
	});

	it("respond-meeting POSTs to /api/meetings/:id/respond and forwards reason", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				resolved: true,
				schedulingId: "sch-1",
				requestId: "inbound-target",
				approve: false,
				report: { synced: true, processed: 0, pendingRequests: [], pendingDeliveries: [] },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await messageRespondMeetingCommand(
			"sch-1",
			{ reject: true, reason: "Need to decline" },
			{ plain: true },
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:4321/api/meetings/sch-1/respond");
		expect(JSON.parse(init.body as string)).toEqual({
			approve: false,
			reason: "Need to decline",
		});
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("cancel-meeting POSTs to /api/meetings/:id/cancel and forwards reason", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				requestId: "matched-request",
				peerAgentId: 10,
				schedulingId: "sch-2",
				report: { synced: true, processed: 1, pendingRequests: [], pendingDeliveries: [] },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await messageCancelMeetingCommand("sch-2", { reason: "Conflict" }, { plain: true });

		expect(fetchMock).toHaveBeenCalledOnce();
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ reason: "Conflict" });
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("respond-meeting dry-run skips the network call", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await messageRespondMeetingCommand(
			"sch-3",
			{ accept: true, dryRun: true },
			{ plain: true },
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({
				dry_run: true,
				scope: "scheduling/respond",
				scheduling_id: "sch-3",
				action: "accept",
				status: "preview",
			}),
			expect.anything(),
			expect.any(Number),
		);
	});

	it("cancel-meeting dry-run skips the network call", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await messageCancelMeetingCommand(
			"sch-4",
			{ reason: "Conflict", dryRun: true },
			{ plain: true },
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(successMock).toHaveBeenCalledWith(
			expect.objectContaining({
				dry_run: true,
				scope: "scheduling/cancel",
				scheduling_id: "sch-4",
				reason: "Conflict",
				status: "preview",
			}),
			expect.anything(),
			expect.any(Number),
		);
	});
});
