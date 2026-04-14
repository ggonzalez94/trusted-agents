import { describe, expect, it } from "vitest";
import { drainAndFormatNotifications } from "../src/notifications-drain.js";
import type { OpenClawTapdClient, TapNotification } from "../src/tapd-client.js";

function clientWith(notifications: TapNotification[]): OpenClawTapdClient {
	return {
		drainNotifications: async () => ({ notifications }),
	} as unknown as OpenClawTapdClient;
}

function note(
	id: string,
	type: TapNotification["type"],
	oneLiner: string,
): TapNotification {
	return { id, type, oneLiner, createdAt: "2026-01-01T00:00:00Z" };
}

describe("drainAndFormatNotifications", () => {
	it("returns null when the queue is empty", async () => {
		const result = await drainAndFormatNotifications(clientWith([]));
		expect(result).toBeNull();
	});

	it("renders a single info notification with its label", async () => {
		const result = await drainAndFormatNotifications(
			clientWith([note("1", "info", "alice said hi")]),
		);
		expect(result).toEqual({
			prependContext: ["[TAP Notifications]", "- INFO: alice said hi"].join("\n"),
		});
	});

	it("renders mixed notification types with the right labels", async () => {
		const result = await drainAndFormatNotifications(
			clientWith([
				note("1", "escalation", "transfer needs approval"),
				note("2", "auto-reply", "auto reply sent"),
				note("3", "summary", "10 messages summarized"),
				note("4", "info", "fyi"),
			]),
		);
		expect(result?.prependContext).toBe(
			[
				"[TAP Notifications]",
				"- ESCALATION: transfer needs approval",
				"- AUTO-REPLY: auto reply sent",
				"- SUMMARY: 10 messages summarized",
				"- INFO: fyi",
			].join("\n"),
		);
	});

	it("skips entries with empty one-liners", async () => {
		const result = await drainAndFormatNotifications(
			clientWith([
				note("1", "info", "  "),
				note("2", "info", "kept"),
				note("3", "info", ""),
			]),
		);
		expect(result?.prependContext).toBe(["[TAP Notifications]", "- INFO: kept"].join("\n"));
	});

	it("returns null when every entry has an empty one-liner", async () => {
		const result = await drainAndFormatNotifications(
			clientWith([note("1", "info", ""), note("2", "info", "  ")]),
		);
		expect(result).toBeNull();
	});

	it("truncates at 20 notifications and emits a SUMMARY footer for the rest", async () => {
		const notifications: TapNotification[] = [];
		for (let i = 0; i < 25; i += 1) {
			notifications.push(note(String(i), "info", `msg ${i}`));
		}
		const result = await drainAndFormatNotifications(clientWith(notifications));
		const lines = result?.prependContext.split("\n") ?? [];
		expect(lines[0]).toBe("[TAP Notifications]");
		// 1 header + 20 messages + 1 summary footer = 22
		expect(lines).toHaveLength(22);
		expect(lines[lines.length - 1]).toBe("- SUMMARY: 5 more TAP notifications omitted.");
	});
});
