import { describe, expect, it } from "vitest";
import { NotificationQueue, type TapNotification } from "../../src/notification-queue.js";

function makeNotification(overrides: Partial<TapNotification> = {}): TapNotification {
	return {
		id: "note-1",
		type: "info",
		oneLiner: "Connection established with Bob",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("NotificationQueue", () => {
	it("starts empty", () => {
		const q = new NotificationQueue();
		expect(q.drain()).toEqual([]);
	});

	it("enqueues and drains notifications", () => {
		const q = new NotificationQueue();
		q.enqueue(makeNotification({ id: "a" }));
		q.enqueue(makeNotification({ id: "b" }));

		const drained = q.drain();
		expect(drained.map((n) => n.id)).toEqual(["a", "b"]);
		expect(q.drain()).toEqual([]);
	});

	it("returns notifications in FIFO order", () => {
		const q = new NotificationQueue();
		for (let i = 0; i < 5; i += 1) {
			q.enqueue(makeNotification({ id: `n-${i}` }));
		}
		const drained = q.drain();
		expect(drained.map((n) => n.id)).toEqual(["n-0", "n-1", "n-2", "n-3", "n-4"]);
	});
});
