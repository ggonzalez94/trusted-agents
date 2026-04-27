import { describe, expect, it } from "vitest";
import { extractConnectionIdFromParams } from "../../../src/protocol/messages.js";

describe("extractConnectionIdFromParams", () => {
	it("extracts a trusted agent connection id from message metadata", () => {
		expect(
			extractConnectionIdFromParams({
				message: {
					metadata: {
						trustedAgent: {
							connectionId: "conn-123",
						},
					},
				},
			}),
		).toBe("conn-123");
	});

	it.each([null, undefined, "not-object", { message: "not-object" }, { message: {} }])(
		"returns null for malformed params %#",
		(params) => {
			expect(extractConnectionIdFromParams(params)).toBeNull();
		},
	);
});
