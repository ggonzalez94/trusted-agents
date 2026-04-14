import { describe, expect, it, vi } from "vitest";
import { createMeetingsRoutes } from "../../../src/http/routes/meetings.js";

const validProposal = {
	type: "scheduling/propose" as const,
	schedulingId: "sched-1",
	title: "Sync",
	duration: 30,
	slots: [{ start: "2026-04-14T10:00:00Z", end: "2026-04-14T10:30:00Z" }],
	originTimezone: "UTC",
};

function makeService() {
	return {
		requestMeeting: vi.fn(async (input: { peer: string; proposal: typeof validProposal }) => ({
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
		it("forwards a valid proposal to service.requestMeeting", async () => {
			const service = makeService();
			const { request } = createMeetingsRoutes(service as never);

			const result = await request({}, { peer: "Alice", proposal: validProposal });

			expect(service.requestMeeting).toHaveBeenCalledOnce();
			expect(result.schedulingId).toBe("sched-1");
			expect(result.peerName).toBe("Alice");
		});

		it("rejects bodies missing peer", async () => {
			const { request } = createMeetingsRoutes(makeService() as never);
			await expect(request({}, { proposal: validProposal })).rejects.toThrow();
		});

		it("rejects malformed proposals", async () => {
			const { request } = createMeetingsRoutes(makeService() as never);
			await expect(
				request({}, { peer: "Alice", proposal: { ...validProposal, type: "wrong" } }),
			).rejects.toThrow();
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
