import type {
	Contact,
	SchedulingDecision,
	SchedulingHandler,
	TapActionContext,
} from "trusted-agents-core";
import { describe, expect, it, vi } from "vitest";
import { handleSchedulingRequest } from "../src/handler.js";

function buildMockContext(
	overrides: Partial<{
		payload: Record<string, unknown>;
		grantsToPeer: Array<{
			grantId: string;
			scope: string;
			constraints?: Record<string, unknown>;
			status: "active" | "revoked";
			updatedAt: string;
		}>;
		extensions: Record<string, unknown>;
	}> = {},
): TapActionContext {
	return {
		self: {
			agentId: 1,
			chain: "eip155:8453",
			address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
		},
		peer: {
			contact: {
				connectionId: "conn-1",
				peerAgentId: 2,
				peerChain: "eip155:8453",
				peerAddress: "0x2222222222222222222222222222222222222222" as `0x${string}`,
				peerXmtpId: "peer-xmtp-id",
				peerDisplayName: "Test Peer",
				status: "active",
				createdAt: new Date().toISOString(),
				permissions: {
					grantedByMe: {
						version: "tap-grants/v1",
						updatedAt: new Date().toISOString(),
						grants: overrides.grantsToPeer ?? [],
					},
					grantedByPeer: {
						version: "tap-grants/v1",
						updatedAt: new Date().toISOString(),
						grants: [],
					},
				},
			},
			grantsFromPeer: [],
			grantsToPeer: overrides.grantsToPeer ?? [],
		},
		payload: overrides.payload ?? {
			type: "scheduling/propose",
			schedulingId: "sch_test_001",
			title: "Team Standup",
			duration: 30,
			slots: [
				{
					start: "2026-04-01T10:00:00Z",
					end: "2026-04-01T10:30:00Z",
				},
				{
					start: "2026-04-01T14:00:00Z",
					end: "2026-04-01T14:30:00Z",
				},
			],
			originTimezone: "America/New_York",
		},
		messaging: {
			reply: vi.fn().mockResolvedValue(undefined),
			send: vi.fn().mockResolvedValue(undefined),
		},
		payments: {
			request: vi.fn().mockResolvedValue({ requestId: "req-1" }),
			execute: vi.fn().mockResolvedValue({ txHash: "0xabc" }),
		},
		storage: {
			get: vi.fn().mockResolvedValue(undefined),
			set: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			list: vi.fn().mockResolvedValue({}),
		},
		events: {
			emit: vi.fn(),
		},
		log: {
			append: vi.fn().mockResolvedValue(undefined),
		},
		extensions: overrides.extensions ?? {},
	};
}

function buildMockContact(): Contact {
	return {
		connectionId: "conn-1",
		peerAgentId: 2,
		peerChain: "eip155:8453",
		peerAddress: "0x2222222222222222222222222222222222222222" as `0x${string}`,
		peerXmtpId: "peer-xmtp-id",
		peerDisplayName: "Test Peer",
		status: "active",
		createdAt: new Date().toISOString(),
		permissions: {
			grantedByMe: {
				version: "tap-grants/v1",
				updatedAt: new Date().toISOString(),
				grants: [
					{
						grantId: "g1",
						scope: "scheduling/request",
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				],
			},
			grantedByPeer: {
				version: "tap-grants/v1",
				updatedAt: new Date().toISOString(),
				grants: [],
			},
		},
	};
}

function buildMockSchedulingHandler(decision: SchedulingDecision): {
	handler: SchedulingHandler;
	evaluateProposal: ReturnType<typeof vi.fn>;
} {
	const evaluateProposal = vi.fn().mockResolvedValue(decision);
	const handler = {
		evaluateProposal,
	} as unknown as SchedulingHandler;
	return { handler, evaluateProposal };
}

describe("handleSchedulingRequest", () => {
	describe("payload validation", () => {
		it.each<[string, Record<string, unknown>]>([
			["missing required fields", { type: "scheduling/request" }],
			["wrong type", { type: "something-else" }],
			[
				"empty title",
				{
					type: "scheduling/propose",
					title: "",
					duration: 30,
					slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" }],
				},
			],
			[
				"zero duration",
				{
					type: "scheduling/propose",
					title: "Standup",
					duration: 0,
					slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" }],
				},
			],
			["empty slots", { type: "scheduling/propose", title: "Standup", duration: 30, slots: [] }],
			[
				"start >= end",
				{
					type: "scheduling/propose",
					title: "Standup",
					duration: 30,
					slots: [{ start: "2026-04-01T10:30:00Z", end: "2026-04-01T10:00:00Z" }],
				},
			],
		])("should reject with INVALID_PAYLOAD when %s", async (_, payload) => {
			const result = await handleSchedulingRequest(buildMockContext({ payload }));
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("INVALID_PAYLOAD");
		});
	});

	describe("grant-only fallback (no SchedulingHandler)", () => {
		it("should reject when no grant matches", async () => {
			const ctx = buildMockContext({
				grantsToPeer: [],
			});

			const result = await handleSchedulingRequest(ctx);

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NO_MATCHING_GRANT");
			expect(result.data?.schedulingId).toBeDefined();
			expect(ctx.events.emit).toHaveBeenCalledWith(
				expect.objectContaining({ type: "scheduling/rejected" }),
			);
		});

		it.each<[string, Parameters<typeof buildMockContext>[0]]>([
			[
				"wrong scope",
				{
					grantsToPeer: [
						{
							grantId: "g1",
							scope: "message/send",
							status: "active",
							updatedAt: new Date().toISOString(),
						},
					],
				},
			],
			[
				"revoked grant",
				{
					grantsToPeer: [
						{
							grantId: "g1",
							scope: "scheduling/request",
							status: "revoked",
							updatedAt: new Date().toISOString(),
						},
					],
				},
			],
			[
				"duration exceeds maxDurationMinutes",
				{
					payload: {
						type: "scheduling/propose",
						title: "Long Meeting",
						duration: 120,
						slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T12:00:00Z" }],
						originTimezone: "UTC",
					},
					grantsToPeer: [
						{
							grantId: "g1",
							scope: "scheduling/request",
							constraints: { maxDurationMinutes: 60 },
							status: "active",
							updatedAt: new Date().toISOString(),
						},
					],
				},
			],
		])("should reject with NO_MATCHING_GRANT when %s", async (_, overrides) => {
			const result = await handleSchedulingRequest(buildMockContext(overrides));
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NO_MATCHING_GRANT");
		});

		it("should accept when a matching grant exists", async () => {
			const ctx = buildMockContext({
				grantsToPeer: [
					{
						grantId: "g1",
						scope: "scheduling/request",
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				],
			});

			const result = await handleSchedulingRequest(ctx);

			expect(result.success).toBe(true);
			expect(result.data?.type).toBe("scheduling/accept");
			expect(result.data?.acceptedSlot).toBeDefined();
			expect(ctx.events.emit).toHaveBeenCalledWith(
				expect.objectContaining({ type: "scheduling/accepted" }),
			);
		});

		it("should accept with constrained grant that matches", async () => {
			const ctx = buildMockContext({
				grantsToPeer: [
					{
						grantId: "g1",
						scope: "scheduling/request",
						constraints: { maxDurationMinutes: 60 },
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				],
			});

			const result = await handleSchedulingRequest(ctx);

			expect(result.success).toBe(true);
			expect(result.data?.type).toBe("scheduling/accept");
		});

		it("should use default timezone when not provided", async () => {
			const ctx = buildMockContext({
				payload: {
					type: "scheduling/propose",
					title: "Quick Chat",
					duration: 15,
					slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:15:00Z" }],
				},
				grantsToPeer: [
					{
						grantId: "g1",
						scope: "scheduling/request",
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				],
			});

			const result = await handleSchedulingRequest(ctx);

			expect(result.success).toBe(true);
			expect(result.data?.type).toBe("scheduling/accept");
		});

		it("should include note in accepted response", async () => {
			const ctx = buildMockContext({
				grantsToPeer: [
					{
						grantId: "g1",
						scope: "scheduling/request",
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				],
			});

			const result = await handleSchedulingRequest(ctx);

			expect(result.success).toBe(true);
			expect(result.data?.note).toBeDefined();
		});
	});

	describe("SchedulingHandler delegation", () => {
		it("should delegate to SchedulingHandler when available and return confirm", async () => {
			const contact = buildMockContact();
			const { handler, evaluateProposal } = buildMockSchedulingHandler({
				action: "confirm",
				slot: { start: "2026-04-01T14:00:00Z", end: "2026-04-01T14:30:00Z" },
				proposal: {
					type: "scheduling/propose",
					schedulingId: "sch_test",
					title: "Team Standup",
					duration: 30,
					slots: [
						{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" },
						{ start: "2026-04-01T14:00:00Z", end: "2026-04-01T14:30:00Z" },
					],
					originTimezone: "America/New_York",
				},
			});

			const ctx = buildMockContext({
				payload: {
					type: "scheduling/propose",
					title: "Team Standup",
					duration: 30,
					schedulingId: "sch_test",
					slots: [
						{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" },
						{ start: "2026-04-01T14:00:00Z", end: "2026-04-01T14:30:00Z" },
					],
					originTimezone: "America/New_York",
				},
				extensions: {
					schedulingHandler: handler,
					contact,
				},
			});

			const result = await handleSchedulingRequest(ctx);

			expect(result.success).toBe(true);
			expect(result.data?.type).toBe("scheduling/accept");
			expect(result.data?.acceptedSlot).toEqual({
				start: "2026-04-01T14:00:00Z",
				end: "2026-04-01T14:30:00Z",
			});
			expect(evaluateProposal).toHaveBeenCalledOnce();
			expect(evaluateProposal).toHaveBeenCalledWith(
				"sch_test",
				contact,
				expect.objectContaining({ title: "Team Standup" }),
			);
		});

		it("should return counter slots from SchedulingHandler", async () => {
			const contact = buildMockContact();
			const counterSlots = [
				{ start: "2026-04-02T09:00:00Z", end: "2026-04-02T09:30:00Z" },
				{ start: "2026-04-02T15:00:00Z", end: "2026-04-02T15:30:00Z" },
			];
			const { handler, evaluateProposal } = buildMockSchedulingHandler({
				action: "counter",
				slots: counterSlots,
				proposal: {
					type: "scheduling/propose",
					schedulingId: "sch_test",
					title: "Team Standup",
					duration: 30,
					slots: [],
					originTimezone: "UTC",
				},
			});

			const ctx = buildMockContext({
				payload: {
					type: "scheduling/propose",
					title: "Team Standup",
					duration: 30,
					schedulingId: "sch_test",
					slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" }],
					originTimezone: "UTC",
				},
				extensions: {
					schedulingHandler: handler,
					contact,
				},
			});

			const result = await handleSchedulingRequest(ctx);

			expect(result.success).toBe(true);
			expect(result.data?.type).toBe("scheduling/counter");
			expect(result.data?.counterSlots).toEqual(counterSlots);
			expect(evaluateProposal).toHaveBeenCalledOnce();
		});

		it("should return reject from SchedulingHandler", async () => {
			const contact = buildMockContact();
			const { handler } = buildMockSchedulingHandler({
				action: "reject",
				reason: "No available time slots",
			});

			const ctx = buildMockContext({
				payload: {
					type: "scheduling/propose",
					title: "Team Standup",
					duration: 30,
					schedulingId: "sch_reject",
					slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" }],
				},
				extensions: {
					schedulingHandler: handler,
					contact,
				},
			});

			const result = await handleSchedulingRequest(ctx);

			expect(result.success).toBe(false);
			expect(result.data?.type).toBe("scheduling/reject");
			expect(result.data?.reason).toBe("No available time slots");
			expect(result.error?.code).toBe("REJECTED");
			expect(result.error?.message).toBe("No available time slots");
		});

		it("should return defer from SchedulingHandler", async () => {
			const contact = buildMockContact();
			const { handler } = buildMockSchedulingHandler({
				action: "defer",
			});

			const ctx = buildMockContext({
				payload: {
					type: "scheduling/propose",
					title: "Team Standup",
					duration: 30,
					schedulingId: "sch_defer",
					slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" }],
				},
				extensions: {
					schedulingHandler: handler,
					contact,
				},
			});

			const result = await handleSchedulingRequest(ctx);

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("DEFERRED");
			expect(result.error?.message).toBe("Scheduling request deferred for approval");
		});

		it("should never auto-accept when SchedulingHandler is available", async () => {
			// Even with valid grants, the SchedulingHandler's decision takes precedence
			const contact = buildMockContact();
			const { handler } = buildMockSchedulingHandler({
				action: "reject",
				reason: "Calendar conflict",
			});

			const ctx = buildMockContext({
				grantsToPeer: [
					{
						grantId: "g1",
						scope: "scheduling/request",
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				],
				payload: {
					type: "scheduling/propose",
					title: "Team Standup",
					duration: 30,
					schedulingId: "sch_no_auto",
					slots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" }],
				},
				extensions: {
					schedulingHandler: handler,
					contact,
				},
			});

			const result = await handleSchedulingRequest(ctx);

			// Should reject based on SchedulingHandler decision, not auto-accept based on grants
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("REJECTED");
			expect(result.error?.message).toBe("Calendar conflict");
		});

		it("should fall back to grant-only evaluation when only contact is in extensions", async () => {
			const contact = buildMockContact();
			const ctx = buildMockContext({
				grantsToPeer: [
					{
						grantId: "g1",
						scope: "scheduling/request",
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				],
				extensions: {
					contact,
					// No schedulingHandler
				},
			});

			const result = await handleSchedulingRequest(ctx);

			// Should use grant-only fallback and accept
			expect(result.success).toBe(true);
			expect(result.data?.type).toBe("scheduling/accept");
		});

		it("should fall back to grant-only evaluation when only schedulingHandler is in extensions", async () => {
			const { handler } = buildMockSchedulingHandler({ action: "defer" });
			const ctx = buildMockContext({
				grantsToPeer: [
					{
						grantId: "g1",
						scope: "scheduling/request",
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				],
				extensions: {
					schedulingHandler: handler,
					// No contact
				},
			});

			const result = await handleSchedulingRequest(ctx);

			// Should use grant-only fallback and accept (not defer from handler)
			expect(result.success).toBe(true);
			expect(result.data?.type).toBe("scheduling/accept");
		});
	});
});
