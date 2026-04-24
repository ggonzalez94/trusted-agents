import { describe, expect, it } from "vitest";
import {
	buildEqualSplits,
	deriveExpenseGroupId,
	formatUsdcMinor,
	parseUsdcAmount,
} from "../src/index.js";

describe("expense amount helpers", () => {
	it("parses decimal USDC amounts into minor units", () => {
		expect(parseUsdcAmount("45")).toBe(45_000_000n);
		expect(parseUsdcAmount("22.50")).toBe(22_500_000n);
		expect(parseUsdcAmount("0.000001")).toBe(1n);
	});

	it("rejects invalid or over-precise USDC amounts", () => {
		expect(() => parseUsdcAmount("0")).toThrow("positive");
		expect(() => parseUsdcAmount("-1")).toThrow("positive");
		expect(() => parseUsdcAmount("1.0000001")).toThrow("at most 6 decimal places");
		expect(() => parseUsdcAmount("abc")).toThrow("Invalid USDC amount");
	});

	it("formats minor units back into decimal USDC", () => {
		expect(formatUsdcMinor(45_000_000n)).toBe("45");
		expect(formatUsdcMinor(22_500_000n)).toBe("22.5");
		expect(formatUsdcMinor(1n)).toBe("0.000001");
	});

	it("splits remainders deterministically by participant order", () => {
		const splits = buildEqualSplits(10_000_001n, [
			{ agentId: 2, chain: "eip155:8453" },
			{ agentId: 1, chain: "eip155:8453" },
		]);

		expect(splits).toEqual([
			{ agentId: 2, chain: "eip155:8453", amountMinor: "5000001" },
			{ agentId: 1, chain: "eip155:8453", amountMinor: "5000000" },
		]);
	});

	it("derives a stable group id independent of participant order", () => {
		const left = deriveExpenseGroupId([
			{ agentId: 2, chain: "eip155:8453" },
			{ agentId: 1, chain: "eip155:8453" },
		]);
		const right = deriveExpenseGroupId([
			{ agentId: 1, chain: "eip155:8453" },
			{ agentId: 2, chain: "eip155:8453" },
		]);

		expect(left).toBe(right);
		expect(left).toBe("expgrp_eip155_8453_1_eip155_8453_2");
	});
});
