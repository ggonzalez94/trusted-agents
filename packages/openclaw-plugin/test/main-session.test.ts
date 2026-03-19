import { describe, expect, it } from "vitest";
import { resolveOpenClawMainSessionKey } from "../src/main-session.js";

describe("resolveOpenClawMainSessionKey", () => {
	it("defaults to the canonical main session key", () => {
		expect(resolveOpenClawMainSessionKey({})).toBe("agent:main:main");
	});

	it("respects the configured default agent and main key", () => {
		expect(
			resolveOpenClawMainSessionKey({
				session: { mainKey: " Primary " },
				agents: {
					list: [{ id: "fallback-agent" }, { id: "Alpha Agent", default: true }],
				},
			}),
		).toBe("agent:alpha-agent:primary");
	});

	it("sanitizes mainKey containing colons or special characters", () => {
		expect(
			resolveOpenClawMainSessionKey({
				session: { mainKey: "foo:bar:baz" },
			}),
		).toBe("agent:main:foo-bar-baz");
	});

	it("uses the global session when OpenClaw runs in global scope", () => {
		expect(
			resolveOpenClawMainSessionKey({
				session: { scope: "global", mainKey: "ignored" },
				agents: { list: [{ id: "custom" }] },
			}),
		).toBe("global");
	});
});
