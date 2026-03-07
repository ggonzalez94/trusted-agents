import { describe, expect, it } from "vitest";
import { parseTapOpenClawPluginConfig } from "../src/config.js";

describe("parseTapOpenClawPluginConfig", () => {
	it("defaults unnamed identities and reconcile intervals", () => {
		expect(
			parseTapOpenClawPluginConfig({
				identities: [{ dataDir: "/tmp/a" }, { dataDir: "/tmp/b", autoApproveConnections: true }],
			}),
		).toEqual({
			identities: [
				{
					name: "default",
					dataDir: "/tmp/a",
					autoApproveConnections: false,
					autoApproveActions: false,
					reconcileIntervalMinutes: 10,
				},
				{
					name: "identity-2",
					dataDir: "/tmp/b",
					autoApproveConnections: true,
					autoApproveActions: false,
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
});
