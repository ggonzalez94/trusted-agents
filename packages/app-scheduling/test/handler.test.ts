import type { TapActionContext } from "trusted-agents-core";
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
			type: "scheduling/request",
			title: "Team Standup",
			durationMinutes: 30,
			proposedSlots: [
				{
					start: "2026-04-01T10:00:00Z",
					end: "2026-04-01T10:30:00Z",
				},
				{
					start: "2026-04-01T14:00:00Z",
					end: "2026-04-01T14:30:00Z",
				},
			],
			timezone: "America/New_York",
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
	};
}

describe("handleSchedulingRequest", () => {
	it("should reject when payload is missing required fields", async () => {
		const ctx = buildMockContext({
			payload: { type: "scheduling/request" },
		});

		const result = await handleSchedulingRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("INVALID_PAYLOAD");
	});

	it("should reject when payload type is wrong", async () => {
		const ctx = buildMockContext({
			payload: { type: "something-else" },
		});

		const result = await handleSchedulingRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("INVALID_PAYLOAD");
	});

	it("should reject when title is empty", async () => {
		const ctx = buildMockContext({
			payload: {
				type: "scheduling/request",
				title: "",
				durationMinutes: 30,
				proposedSlots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" }],
			},
		});

		const result = await handleSchedulingRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("INVALID_PAYLOAD");
	});

	it("should reject when durationMinutes is not positive", async () => {
		const ctx = buildMockContext({
			payload: {
				type: "scheduling/request",
				title: "Standup",
				durationMinutes: 0,
				proposedSlots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:30:00Z" }],
			},
		});

		const result = await handleSchedulingRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("INVALID_PAYLOAD");
	});

	it("should reject when proposedSlots is empty", async () => {
		const ctx = buildMockContext({
			payload: {
				type: "scheduling/request",
				title: "Standup",
				durationMinutes: 30,
				proposedSlots: [],
			},
		});

		const result = await handleSchedulingRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("INVALID_PAYLOAD");
	});

	it("should reject when proposedSlot has start >= end", async () => {
		const ctx = buildMockContext({
			payload: {
				type: "scheduling/request",
				title: "Standup",
				durationMinutes: 30,
				proposedSlots: [{ start: "2026-04-01T10:30:00Z", end: "2026-04-01T10:00:00Z" }],
			},
		});

		const result = await handleSchedulingRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("INVALID_PAYLOAD");
	});

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

	it("should reject when grant has wrong scope", async () => {
		const ctx = buildMockContext({
			grantsToPeer: [
				{
					grantId: "g1",
					scope: "message/send",
					status: "active",
					updatedAt: new Date().toISOString(),
				},
			],
		});

		const result = await handleSchedulingRequest(ctx);

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
		expect(ctx.log.append).toHaveBeenCalled();
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

	it("should reject when grant is revoked", async () => {
		const ctx = buildMockContext({
			grantsToPeer: [
				{
					grantId: "g1",
					scope: "scheduling/request",
					status: "revoked",
					updatedAt: new Date().toISOString(),
				},
			],
		});

		const result = await handleSchedulingRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("NO_MATCHING_GRANT");
	});

	it("should reject when duration exceeds grant maxDurationMinutes", async () => {
		const ctx = buildMockContext({
			payload: {
				type: "scheduling/request",
				title: "Long Meeting",
				durationMinutes: 120,
				proposedSlots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T12:00:00Z" }],
				timezone: "UTC",
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
		});

		const result = await handleSchedulingRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("NO_MATCHING_GRANT");
	});

	it("should use default timezone when not provided", async () => {
		const ctx = buildMockContext({
			payload: {
				type: "scheduling/request",
				title: "Quick Chat",
				durationMinutes: 15,
				proposedSlots: [{ start: "2026-04-01T10:00:00Z", end: "2026-04-01T10:15:00Z" }],
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
