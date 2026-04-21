/**
 * Tests for `tap message respond-meeting` and `tap message cancel-meeting`
 * after the Phase 3 refactor and the Unix-socket migration — both are
 * tapd HTTP-over-Unix-socket clients now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeTapdHandle, startFakeTapd } from "./helpers/fake-tapd-socket.ts";

const { loadConfigMock, successMock, errorMock, verboseMock } = vi.hoisted(() => ({
	loadConfigMock: vi.fn(),
	successMock: vi.fn(),
	errorMock: vi.fn(),
	verboseMock: vi.fn(),
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
	return { ...actual, success: successMock, error: errorMock, verbose: verboseMock };
});

import { messageCancelMeetingCommand } from "../src/commands/message-cancel-meeting.js";
import { messageRespondMeetingCommand } from "../src/commands/message-respond-meeting.js";

describe("meeting CLI commands (tapd client refactor)", () => {
	let fake: FakeTapdHandle | null;

	beforeEach(async () => {
		fake = null;
		// Dry-run tests still need loadConfig to resolve to *some* dataDir;
		// they short-circuit before calling tapd.
		loadConfigMock.mockResolvedValue({ dataDir: "/tmp/tap-meet-dryrun-stub" });
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await fake?.stop();
		process.exitCode = 0;
	});

	async function withFakeTapd(
		routes: Parameters<typeof startFakeTapd>[0]["routes"],
	): Promise<void> {
		fake = await startFakeTapd({ routes });
		loadConfigMock.mockResolvedValue({ dataDir: fake.dataDir });
	}

	it("respond-meeting POSTs to /api/meetings/:id/respond and forwards reason", async () => {
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/meetings/:id/respond",
				handler: () => ({
					resolved: true,
					schedulingId: "sch-1",
					requestId: "inbound-target",
					approve: false,
					report: { synced: true, processed: 0, pendingRequests: [], pendingDeliveries: [] },
				}),
			},
		]);

		await messageRespondMeetingCommand(
			"sch-1",
			{ reject: true, reason: "Need to decline" },
			{ plain: true },
		);

		expect(fake?.calls).toHaveLength(1);
		expect(fake?.calls[0]?.path).toBe("/api/meetings/sch-1/respond");
		expect(fake?.calls[0]?.body).toEqual({
			approve: false,
			reason: "Need to decline",
		});
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("cancel-meeting POSTs to /api/meetings/:id/cancel and forwards reason", async () => {
		await withFakeTapd([
			{
				method: "POST",
				path: "/api/meetings/:id/cancel",
				handler: () => ({
					requestId: "matched-request",
					peerAgentId: 10,
					schedulingId: "sch-2",
					report: { synced: true, processed: 1, pendingRequests: [], pendingDeliveries: [] },
				}),
			},
		]);

		await messageCancelMeetingCommand("sch-2", { reason: "Conflict" }, { plain: true });

		expect(fake?.calls).toHaveLength(1);
		expect(fake?.calls[0]?.path).toBe("/api/meetings/sch-2/cancel");
		expect(fake?.calls[0]?.body).toEqual({ reason: "Conflict" });
		expect(errorMock).not.toHaveBeenCalled();
	});

	it("respond-meeting dry-run skips the network call", async () => {
		await messageRespondMeetingCommand("sch-3", { accept: true, dryRun: true }, { plain: true });

		expect(fake).toBeNull();
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
		await messageCancelMeetingCommand(
			"sch-4",
			{ reason: "Conflict", dryRun: true },
			{ plain: true },
		);

		expect(fake).toBeNull();
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
