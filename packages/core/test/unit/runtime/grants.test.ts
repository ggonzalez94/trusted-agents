import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/common/index.js";
import { normalizeGrantInput } from "../../../src/runtime/grants.js";

describe("normalizeGrantInput", () => {
	it("normalizes an array of grant-like objects", () => {
		const grantSet = normalizeGrantInput([
			{
				grantId: "g1",
				scope: "transfer/request",
				constraints: { maxAmount: "10" },
				status: "active",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		]);

		expect(grantSet.grants).toEqual([
			{
				grantId: "g1",
				scope: "transfer/request",
				constraints: { maxAmount: "10" },
				status: "active",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		]);
	});

	it("preserves whitespace-only grant ids and scopes as non-empty strings", () => {
		const grantSet = normalizeGrantInput([{ grantId: " ", scope: "\t" }]);

		expect(grantSet.grants[0]?.grantId).toBe(" ");
		expect(grantSet.grants[0]?.scope).toBe("\t");
	});

	it("rejects array constraints", () => {
		expect(() =>
			normalizeGrantInput([{ grantId: "g1", scope: "transfer/request", constraints: [] }]),
		).toThrow(ValidationError);
	});
});
