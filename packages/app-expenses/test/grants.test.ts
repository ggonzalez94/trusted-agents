import type { PermissionGrantSet } from "trusted-agents-core";
import { describe, expect, it } from "vitest";
import { findApplicableExpenseSettlementGrants } from "../src/index.js";

const grantSet = {
	version: "tap-grants/v1",
	updatedAt: "2026-04-23T00:00:00.000Z",
	grants: [
		{
			grantId: "weekly-base",
			scope: "expense/settle",
			status: "active",
			updatedAt: "2026-04-23T00:00:00.000Z",
			constraints: {
				asset: "usdc",
				chains: ["eip155:8453"],
				maxAmount: "100",
				threshold: "25",
				schedule: "weekly",
			},
		},
		{
			grantId: "revoked",
			scope: "expense/settle",
			status: "revoked",
			updatedAt: "2026-04-23T00:00:00.000Z",
		},
	],
} satisfies PermissionGrantSet;

describe("expense settlement grants", () => {
	it("matches active grants that cover amount, chain, asset, threshold, and schedule", () => {
		const matches = findApplicableExpenseSettlementGrants(grantSet, {
			asset: "usdc",
			amount: "50",
			chain: "eip155:8453",
			reason: "schedule",
			schedule: "weekly",
		});

		expect(matches.map((grant) => grant.grantId)).toEqual(["weekly-base"]);
	});

	it("rejects grants when amount or chain is outside constraints", () => {
		expect(
			findApplicableExpenseSettlementGrants(grantSet, {
				asset: "usdc",
				amount: "101",
				chain: "eip155:8453",
				reason: "schedule",
				schedule: "weekly",
			}),
		).toHaveLength(0);

		expect(
			findApplicableExpenseSettlementGrants(grantSet, {
				asset: "usdc",
				amount: "50",
				chain: "eip155:167000",
				reason: "schedule",
				schedule: "weekly",
			}),
		).toHaveLength(0);
	});

	it("requires threshold settlements to meet the configured threshold", () => {
		expect(
			findApplicableExpenseSettlementGrants(grantSet, {
				asset: "usdc",
				amount: "24.99",
				chain: "eip155:8453",
				reason: "threshold",
			}),
		).toHaveLength(0);

		expect(
			findApplicableExpenseSettlementGrants(grantSet, {
				asset: "usdc",
				amount: "25",
				chain: "eip155:8453",
				reason: "threshold",
			}),
		).toHaveLength(1);
	});

	it("does not use scheduled grants for manual settlement", () => {
		expect(
			findApplicableExpenseSettlementGrants(grantSet, {
				asset: "usdc",
				amount: "50",
				chain: "eip155:8453",
				reason: "manual",
			}),
		).toHaveLength(0);
	});
});
