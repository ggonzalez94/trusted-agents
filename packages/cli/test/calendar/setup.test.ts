import { describe, expect, it } from "vitest";
import { createCalendarProvider } from "../../src/lib/calendar/setup.js";

describe("createCalendarProvider", () => {
	it("throws for unknown providers", () => {
		expect(() => createCalendarProvider("not-supported")).toThrow(
			"Unknown calendar provider: not-supported",
		);
	});
});
