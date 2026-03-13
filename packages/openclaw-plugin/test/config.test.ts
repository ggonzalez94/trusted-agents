import { describe, expect, it } from "vitest";
import { parseTapOpenClawPluginConfig } from "../src/config.js";

describe("parseTapOpenClawPluginConfig", () => {
	it("defaults unnamed identities and reconcile intervals", () => {
		expect(
			parseTapOpenClawPluginConfig({
				identities: [{ dataDir: "/tmp/a" }, { dataDir: "/tmp/b" }],
			}),
		).toEqual({
			identities: [
				{
					name: "default",
					dataDir: "/tmp/a",
					unsafeApproveActions: false,
					reconcileIntervalMinutes: 10,
				},
				{
					name: "identity-2",
					dataDir: "/tmp/b",
					unsafeApproveActions: false,
					reconcileIntervalMinutes: 10,
				},
			],
		});
	});

	it("rejects duplicate identity names", () => {
		expect(() =>
			parseTapOpenClawPluginConfig({
				identities: [
					{ name: "same", dataDir: "/tmp/a" },
					{ name: "same", dataDir: "/tmp/b" },
				],
			}),
		).toThrow("Duplicate TAP plugin identity name");
	});

	it("rejects duplicate identity data dirs after path normalization", () => {
		expect(() =>
			parseTapOpenClawPluginConfig({
				identities: [
					{ name: "alpha", dataDir: "/tmp/tap/agent-a" },
					{ name: "beta", dataDir: "/tmp/tap/../tap/agent-a" },
				],
			}),
		).toThrow("Duplicate TAP plugin identity dataDir");
	});
});
