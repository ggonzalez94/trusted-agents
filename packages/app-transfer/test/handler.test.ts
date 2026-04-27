import { type TapActionContext, createGrantSet } from "trusted-agents-core";
import { describe, expect, it, vi } from "vitest";
import { handleTransferRequest } from "../src/handler.js";

function makeGrant(
	overrides: Partial<{
		grantId: string;
		scope: string;
		constraints: Record<string, unknown>;
		status: "active" | "revoked";
	}> = {},
) {
	return {
		grantId: overrides.grantId ?? "g1",
		scope: overrides.scope ?? "transfer/request",
		status: overrides.status ?? "active",
		updatedAt: new Date().toISOString(),
		...("constraints" in overrides ? { constraints: overrides.constraints } : {}),
	};
}

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
		executeResult: { txHash: `0x${string}` };
		executeError: Error;
	}> = {},
): TapActionContext {
	const executeTransfer = overrides.executeError
		? vi.fn().mockRejectedValue(overrides.executeError)
		: vi.fn().mockResolvedValue(overrides.executeResult ?? { txHash: "0xabc123" as `0x${string}` });

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
					grantedByMe: createGrantSet(overrides.grantsToPeer ?? []),
					grantedByPeer: createGrantSet([]),
				},
			},
			grantsFromPeer: [],
			grantsToPeer: overrides.grantsToPeer ?? [],
		},
		payload: overrides.payload ?? {
			type: "transfer/request",
			actionId: "action-1",
			asset: "usdc",
			amount: "10",
			chain: "eip155:8453",
			toAddress: "0x3333333333333333333333333333333333333333",
		},
		messaging: {
			reply: vi.fn().mockResolvedValue(undefined),
			send: vi.fn().mockResolvedValue(undefined),
		},
		payments: {
			request: vi.fn().mockResolvedValue({ requestId: "req-1" }),
			execute: executeTransfer,
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

describe("handleTransferRequest", () => {
	it.each<[string, Record<string, unknown>]>([
		["missing required fields", { type: "transfer/request", actionId: "a1" }],
		["wrong type", { type: "something-else", actionId: "a1" }],
		[
			"invalid asset",
			{
				type: "transfer/request",
				actionId: "a1",
				asset: "bitcoin",
				amount: "10",
				chain: "eip155:8453",
				toAddress: "0x3333333333333333333333333333333333333333",
			},
		],
		[
			"invalid toAddress",
			{
				type: "transfer/request",
				actionId: "a1",
				asset: "usdc",
				amount: "10",
				chain: "eip155:8453",
				toAddress: "not-an-address",
			},
		],
	])("should reject with INVALID_PAYLOAD when %s", async (_, payload) => {
		const result = await handleTransferRequest(buildMockContext({ payload }));
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("INVALID_PAYLOAD");
	});

	it("should reject when no grant matches", async () => {
		const ctx = buildMockContext({
			grantsToPeer: [],
		});

		const result = await handleTransferRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("NO_MATCHING_GRANT");
		expect(result.data?.status).toBe("rejected");
		expect(ctx.events.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "transfer/rejected" }),
		);
	});

	it.each<[string, Parameters<typeof buildMockContext>[0]]>([
		["wrong scope", { grantsToPeer: [makeGrant({ scope: "message/send" })] }],
		[
			"constrained grant does not match asset",
			{ grantsToPeer: [makeGrant({ constraints: { asset: "native" } })] },
		],
		["revoked grant", { grantsToPeer: [makeGrant({ status: "revoked" })] }],
	])("should reject with NO_MATCHING_GRANT when %s", async (_, overrides) => {
		const result = await handleTransferRequest(buildMockContext(overrides));
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("NO_MATCHING_GRANT");
	});

	it("should succeed when a matching grant exists and transfer executes", async () => {
		const txHash =
			"0x0000000000000000000000000000000000000000000000000000000000000abc" as `0x${string}`;
		const ctx = buildMockContext({
			grantsToPeer: [makeGrant()],
			executeResult: { txHash },
		});

		const result = await handleTransferRequest(ctx);

		expect(result.success).toBe(true);
		expect(result.data?.status).toBe("completed");
		expect(result.data?.txHash).toBe(txHash);
		expect(ctx.payments.execute).toHaveBeenCalledWith({
			asset: "usdc",
			amount: "10",
			chain: "eip155:8453",
			toAddress: "0x3333333333333333333333333333333333333333",
			note: undefined,
		});
		expect(ctx.events.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "transfer/completed" }),
		);
		expect(ctx.log.append).toHaveBeenCalled();
	});

	it("should succeed with constrained grant that matches", async () => {
		const txHash =
			"0x0000000000000000000000000000000000000000000000000000000000000def" as `0x${string}`;
		const ctx = buildMockContext({
			grantsToPeer: [makeGrant({ constraints: { asset: "usdc", chain: "eip155:8453" } })],
			executeResult: { txHash },
		});

		const result = await handleTransferRequest(ctx);

		expect(result.success).toBe(true);
		expect(result.data?.status).toBe("completed");
	});

	it("should return failed when payments.execute throws", async () => {
		const ctx = buildMockContext({
			grantsToPeer: [makeGrant()],
			executeError: new Error("Insufficient balance"),
		});

		const result = await handleTransferRequest(ctx);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("TRANSFER_FAILED");
		expect(result.error?.message).toBe("Insufficient balance");
		expect(result.data?.status).toBe("failed");
		expect(ctx.events.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "transfer/failed" }),
		);
	});

	it("should include note in payload when provided", async () => {
		const txHash =
			"0x0000000000000000000000000000000000000000000000000000000000000111" as `0x${string}`;
		const ctx = buildMockContext({
			payload: {
				type: "transfer/request",
				actionId: "action-note",
				asset: "native",
				amount: "0.5",
				chain: "eip155:8453",
				toAddress: "0x3333333333333333333333333333333333333333",
				note: "For coffee",
			},
			grantsToPeer: [makeGrant()],
			executeResult: { txHash },
		});

		const result = await handleTransferRequest(ctx);

		expect(result.success).toBe(true);
		expect(ctx.payments.execute).toHaveBeenCalledWith(
			expect.objectContaining({ note: "For coffee" }),
		);
	});
});
