import { describe, expect, it } from "vitest";
import { parseTapOpenClawPluginConfig } from "../src/config.js";

describe("parseTapOpenClawPluginConfig", () => {
	it("returns an empty config when nothing is passed", () => {
		expect(parseTapOpenClawPluginConfig(undefined)).toEqual({});
		expect(parseTapOpenClawPluginConfig(null)).toEqual({});
		expect(parseTapOpenClawPluginConfig({})).toEqual({});
	});

	it("trims dataDir and tapdSocketPath", () => {
		expect(
			parseTapOpenClawPluginConfig({
				dataDir: " /tmp/agent ",
				tapdSocketPath: " /tmp/agent/.tapd.sock ",
			}),
		).toEqual({ dataDir: "/tmp/agent", tapdSocketPath: "/tmp/agent/.tapd.sock" });
	});

	it("rejects non-object configs", () => {
		expect(() => parseTapOpenClawPluginConfig([])).toThrow(
			"TAP plugin config must be an object",
		);
		expect(() => parseTapOpenClawPluginConfig("oops")).toThrow(
			"TAP plugin config must be an object",
		);
	});

	it("rejects empty string fields", () => {
		expect(() => parseTapOpenClawPluginConfig({ dataDir: "" })).toThrow("dataDir");
		expect(() => parseTapOpenClawPluginConfig({ tapdSocketPath: "   " })).toThrow(
			"tapdSocketPath",
		);
	});
});
