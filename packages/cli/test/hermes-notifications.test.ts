import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TapNotification } from "../src/hermes/notifications.js";
import { FileTapHermesNotificationStore } from "../src/hermes/notifications.js";

function makeNotification(overrides: Partial<TapNotification> = {}): TapNotification {
	return {
		type: "escalation",
		identity: "default",
		timestamp: "2026-04-07T00:00:00.000Z",
		method: "connection/request",
		from: 7,
		fromName: "HermesPeer",
		messageId: "msg-1",
		detail: {},
		oneLiner: "Connection request from HermesPeer",
		...overrides,
	};
}

describe("FileTapHermesNotificationStore", () => {
	const createdDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			createdDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })),
		);
	});

	it("deduplicates by messageId and drains atomically", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "tap-hermes-notify-"));
		createdDirs.push(stateDir);

		const store = new FileTapHermesNotificationStore(stateDir, 10);
		expect(await store.push(makeNotification())).toBe(true);
		expect(
			await store.push(
				makeNotification({
					oneLiner: "Updated escalation",
				}),
			),
		).toBe(false);

		const queued = await store.peek();
		expect(queued).toHaveLength(1);
		expect(queued[0]?.oneLiner).toBe("Updated escalation");

		const drained = await store.drain();
		expect(drained).toHaveLength(1);
		expect(await store.peek()).toEqual([]);
	});

	it("evicts lower-priority entries before escalations", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "tap-hermes-notify-"));
		createdDirs.push(stateDir);

		const store = new FileTapHermesNotificationStore(stateDir, 2);
		await store.push(makeNotification({ type: "info", messageId: "info-1" }));
		await store.push(makeNotification({ type: "summary", messageId: "summary-1" }));
		await store.push(makeNotification({ type: "escalation", messageId: "esc-1" }));

		const queued = await store.peek();
		expect(queued.map((item) => item.messageId)).toEqual(["summary-1", "esc-1"]);
	});
});
