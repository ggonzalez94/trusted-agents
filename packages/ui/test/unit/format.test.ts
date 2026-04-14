import { describe, expect, it } from "vitest";
import {
	formatAddress,
	formatAgentId,
	formatChain,
	formatInitials,
	formatRelativeTime,
} from "../../lib/format.js";

describe("format", () => {
	describe("formatAddress", () => {
		it("truncates the middle of an Ethereum address", () => {
			expect(formatAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
		});

		it("returns short addresses unchanged", () => {
			expect(formatAddress("0xabc")).toBe("0xabc");
		});

		it("returns empty string for empty input", () => {
			expect(formatAddress("")).toBe("");
		});
	});

	describe("formatChain", () => {
		it("formats Base mainnet", () => {
			expect(formatChain("eip155:8453")).toBe("base");
		});

		it("formats Taiko mainnet", () => {
			expect(formatChain("eip155:167000")).toBe("taiko");
		});

		it("falls back to the CAIP-2 string for unknown chains", () => {
			expect(formatChain("eip155:99999")).toBe("eip155:99999");
		});
	});

	describe("formatAgentId", () => {
		it("renders agent IDs with a hash prefix", () => {
			expect(formatAgentId(42)).toBe("#42");
		});
	});

	describe("formatInitials", () => {
		it("returns first two letters uppercased", () => {
			expect(formatInitials("Alice")).toBe("AL");
		});

		it("handles single-word names", () => {
			expect(formatInitials("Bob")).toBe("BO");
		});

		it("handles short names", () => {
			expect(formatInitials("X")).toBe("X");
		});

		it("returns empty for empty string", () => {
			expect(formatInitials("")).toBe("");
		});
	});

	describe("formatRelativeTime", () => {
		it("returns 'just now' for very recent timestamps", () => {
			const now = new Date();
			expect(formatRelativeTime(now.toISOString(), now)).toBe("just now");
		});

		it("returns minute counts under an hour", () => {
			const now = new Date("2026-04-01T12:00:00Z");
			const past = new Date("2026-04-01T11:55:00Z");
			expect(formatRelativeTime(past.toISOString(), now)).toBe("5m ago");
		});

		it("returns hour counts under a day", () => {
			const now = new Date("2026-04-01T12:00:00Z");
			const past = new Date("2026-04-01T09:00:00Z");
			expect(formatRelativeTime(past.toISOString(), now)).toBe("3h ago");
		});

		it("returns day counts under a week", () => {
			const now = new Date("2026-04-08T12:00:00Z");
			const past = new Date("2026-04-05T12:00:00Z");
			expect(formatRelativeTime(past.toISOString(), now)).toBe("3d ago");
		});
	});
});
