import { describe, expect, it } from "vitest";
import { createNotificationsRoute } from "../../../src/http/routes/notifications.js";
import { NotificationQueue } from "../../../src/notification-queue.js";

describe("notifications route", () => {
	it("returns drained notifications", async () => {
		const q = new NotificationQueue();
		q.enqueue({ id: "a", type: "info", oneLiner: "hello", createdAt: "x" });
		q.enqueue({ id: "b", type: "escalation", oneLiner: "uh oh", createdAt: "y" });
		const handler = createNotificationsRoute(q);

		const result = (await handler({}, undefined)) as { notifications: { id: string }[] };
		expect(result.notifications.map((n) => n.id)).toEqual(["a", "b"]);
		expect(q.size()).toBe(0);
	});

	it("returns empty list when no notifications", async () => {
		const q = new NotificationQueue();
		const handler = createNotificationsRoute(q);
		const result = (await handler({}, undefined)) as { notifications: unknown[] };
		expect(result.notifications).toEqual([]);
	});
});
