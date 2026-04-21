import { describe, expect, it, vi } from "vitest";
import { createMeetingsRoutes } from "../../../src/http/routes/meetings.js";

interface BuiltProposal {
	type: "scheduling/propose";
	schedulingId: string;
	title: string;
	duration: number;
	slots: Array<{ start: string; end: string }>;
	originTimezone: string;
}

function makeService() {
	return {
		requestMeeting: vi.fn(async (input: { peer: string; proposal: BuiltProposal }) => ({
			receipt: { messageId: "m-1", status: "delivered" as const },
			schedulingId: input.proposal.schedulingId,
			peerName: input.peer,
			peerAgentId: 99,
			title: input.proposal.title,
			duration: input.proposal.duration,
			slotCount: input.proposal.slots.length,
		})),
		cancelMeeting: vi.fn(async (schedulingId: string, _reason?: string) => ({
			requestId: "req-1",
			peerAgentId: 99,
			schedulingId,
			report: { synced: true, processed: 1, pendingRequests: [], pendingDeliveries: [] },
		})),
		resolvePending: vi.fn(async () => ({
			synced: true,
			processed: 0,
			pendingRequests: [],
			pendingDeliveries: [],
		})),
		listPendingRequests: vi.fn(async () => [
			{
				requestId: "req-1",
				method: "action/request",
				peerAgentId: 99,
				direction: "inbound",
				kind: "request",
				status: "pending",
				details: { type: "scheduling", schedulingId: "sched-1" },
			},
		]),
	};
}

describe("meetings routes", () => {
	describe("request", () => {
		it("builds a proposal internally with default slot, generated id, and current tz", async () => {
			const service = makeService();
			const { request } = createMeetingsRoutes(service as never);

			await request({}, { peer: "Alice", title: "Standup", duration: 30 });

			expect(service.requestMeeting).toHaveBeenCalledOnce();
			const arg = service.requestMeeting.mock.calls[0][0];
			expect(arg.peer).toBe("Alice");
			expect(arg.proposal.type).toBe("scheduling/propose");
			expect(typeof arg.proposal.schedulingId).toBe("string");
			expect(arg.proposal.schedulingId.length).toBeGreaterThan(0);
			expect(arg.proposal.title).toBe("Standup");
			expect(arg.proposal.duration).toBe(30);
			expect(arg.proposal.slots).toHaveLength(1);
			expect(typeof arg.proposal.slots[0].start).toBe("string");
			expect(typeof arg.proposal.slots[0].end).toBe("string");
			// ~24h ahead
			const startMs = new Date(arg.proposal.slots[0].start).getTime();
			expect(startMs).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
			// originTimezone set from process
			expect(typeof arg.proposal.originTimezone).toBe("string");
			expect(arg.proposal.originTimezone.length).toBeGreaterThan(0);
		});

		it("uses the caller-supplied schedulingId when provided", async () => {
			const service = makeService();
			const { request } = createMeetingsRoutes(service as never);

			await request(
				{},
				{ peer: "Alice", title: "Standup", duration: 30, schedulingId: "sch_caller" },
			);

			const arg = service.requestMeeting.mock.calls[0][0];
			expect(arg.proposal.schedulingId).toBe("sch_caller");
		});

		it("uses the caller-supplied slots array when provided", async () => {
			const service = makeService();
			const { request } = createMeetingsRoutes(service as never);

			const slots = [
				{ start: "2027-01-01T10:00:00.000Z", end: "2027-01-01T10:30:00.000Z" },
				{ start: "2027-01-01T14:00:00.000Z", end: "2027-01-01T14:30:00.000Z" },
			];
			await request({}, { peer: "Alice", title: "Sync", duration: 30, slots });

			const arg = service.requestMeeting.mock.calls[0][0];
			expect(arg.proposal.slots).toEqual(slots);
		});

		it("honors caller-supplied originTimezone", async () => {
			const service = makeService();
			const { request } = createMeetingsRoutes(service as never);

			await request(
				{},
				{ peer: "Alice", title: "Sync", duration: 30, originTimezone: "America/New_York" },
			);

			const arg = service.requestMeeting.mock.calls[0][0];
			expect(arg.proposal.originTimezone).toBe("America/New_York");
		});

		it("propagates location and note onto the built proposal", async () => {
			const service = makeService();
			const { request } = createMeetingsRoutes(service as never);

			await request(
				{},
				{
					peer: "Alice",
					title: "Sync",
					duration: 30,
					location: "Zoom",
					note: "Bring numbers",
				},
			);

			const arg = service.requestMeeting.mock.calls[0][0];
			expect(arg.proposal.location).toBe("Zoom");
			expect(arg.proposal.note).toBe("Bring numbers");
		});

		it("anchors the slot to preferred time when calendar is null", async () => {
			const service = makeService();
			const { request } = createMeetingsRoutes(service as never);

			const preferred = "2027-06-15T09:00:00.000Z";
			await request({}, { peer: "Alice", title: "Sync", duration: 45, preferred });

			const arg = service.requestMeeting.mock.calls[0][0];
			expect(arg.proposal.slots).toHaveLength(1);
			expect(arg.proposal.slots[0].start).toBe(preferred);
		});

		it("rejects missing peer in flat shape", async () => {
			const { request } = createMeetingsRoutes(makeService() as never);
			await expect(request({}, { title: "Standup", duration: 30 })).rejects.toThrow();
		});

		it("rejects missing title in flat shape", async () => {
			const { request } = createMeetingsRoutes(makeService() as never);
			await expect(request({}, { peer: "Alice", duration: 30 })).rejects.toThrow();
		});

		it("rejects missing duration in flat shape", async () => {
			const { request } = createMeetingsRoutes(makeService() as never);
			await expect(request({}, { peer: "Alice", title: "Standup" })).rejects.toThrow();
		});

		it("rejects zero duration", async () => {
			const { request } = createMeetingsRoutes(makeService() as never);
			await expect(request({}, { peer: "Alice", title: "Sync", duration: 0 })).rejects.toThrow();
		});

		it("rejects negative duration", async () => {
			const { request } = createMeetingsRoutes(makeService() as never);
			await expect(request({}, { peer: "Alice", title: "Sync", duration: -5 })).rejects.toThrow();
		});
	});

	describe("respond", () => {
		it("looks up the pending entry and resolves with approve=true", async () => {
			const service = makeService();
			const { respond } = createMeetingsRoutes(service as never);

			const result = await respond({ id: "sched-1" }, { approve: true });

			expect(service.listPendingRequests).toHaveBeenCalledOnce();
			expect(service.resolvePending).toHaveBeenCalledWith("req-1", true, undefined);
			expect(result.resolved).toBe(true);
			expect(result.requestId).toBe("req-1");
			expect(result.approve).toBe(true);
		});

		it("forwards reason to resolvePending when rejecting", async () => {
			const service = makeService();
			const { respond } = createMeetingsRoutes(service as never);

			await respond({ id: "sched-1" }, { approve: false, reason: "conflict" });
			expect(service.resolvePending).toHaveBeenCalledWith("req-1", false, "conflict");
		});

		it("throws when no matching pending entry exists", async () => {
			const service = makeService();
			service.listPendingRequests = vi.fn(async () => []);
			const { respond } = createMeetingsRoutes(service as never);

			await expect(respond({ id: "sched-1" }, { approve: true })).rejects.toThrow(
				/No pending scheduling/,
			);
		});

		it("throws when body is missing approve", async () => {
			const { respond } = createMeetingsRoutes(makeService() as never);
			await expect(respond({ id: "sched-1" }, {})).rejects.toThrow();
		});
	});

	describe("cancel", () => {
		it("forwards schedulingId and reason to service.cancelMeeting", async () => {
			const service = makeService();
			const { cancel } = createMeetingsRoutes(service as never);

			const result = await cancel({ id: "sched-1" }, { reason: "bug bash" });

			expect(service.cancelMeeting).toHaveBeenCalledWith("sched-1", "bug bash");
			expect(result.schedulingId).toBe("sched-1");
		});

		it("accepts an empty body", async () => {
			const service = makeService();
			const { cancel } = createMeetingsRoutes(service as never);

			await cancel({ id: "sched-1" }, undefined);
			expect(service.cancelMeeting).toHaveBeenCalledWith("sched-1", undefined);
		});
	});
});
