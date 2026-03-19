import { describe, expect, it } from "vitest";
import { type TapNotification, TapNotificationQueue } from "../src/notification-queue.js";

function makeNotification(overrides: Partial<TapNotification> = {}): TapNotification {
	return {
		type: "info",
		identity: "default",
		timestamp: new Date().toISOString(),
		method: "message/send",
		from: 42,
		messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
		detail: {},
		oneLiner: "test notification",
		...overrides,
	};
}

describe("TapNotificationQueue", () => {
	describe("push and drain", () => {
		it("returns items in insertion order and clears queue", () => {
			const queue = new TapNotificationQueue();
			const a = makeNotification({ messageId: "a" });
			const b = makeNotification({ messageId: "b" });
			const c = makeNotification({ messageId: "c" });

			queue.push(a);
			queue.push(b);
			queue.push(c);

			const drained = queue.drain();
			expect(drained).toEqual([a, b, c]);
			expect(queue.drain()).toEqual([]);
		});

		it("drain on empty queue returns empty array", () => {
			const queue = new TapNotificationQueue();
			expect(queue.drain()).toEqual([]);
		});
	});

	describe("peek", () => {
		it("returns items without clearing the queue", () => {
			const queue = new TapNotificationQueue();
			const a = makeNotification({ messageId: "a" });
			const b = makeNotification({ messageId: "b" });

			queue.push(a);
			queue.push(b);

			expect(queue.peek()).toEqual([a, b]);
			expect(queue.peek()).toEqual([a, b]);
			// Queue still has items
			expect(queue.drain()).toEqual([a, b]);
		});

		it("returns a copy, not the internal array", () => {
			const queue = new TapNotificationQueue();
			const a = makeNotification({ messageId: "a" });
			queue.push(a);

			const peeked = queue.peek();
			peeked.push(makeNotification({ messageId: "extra" }));

			expect(queue.peek()).toHaveLength(1);
		});
	});

	describe("deduplication", () => {
		it("returns false and drops push when messageId already exists in queue", () => {
			const queue = new TapNotificationQueue();
			const first = makeNotification({ messageId: "dup", type: "summary", oneLiner: "first" });
			const second = makeNotification({ messageId: "dup", type: "escalation", oneLiner: "second" });

			expect(queue.push(first)).toBe(true);
			expect(queue.push(second)).toBe(false);

			const items = queue.drain();
			expect(items).toHaveLength(1);
			expect(items[0]!.oneLiner).toBe("first");
			expect(items[0]!.type).toBe("summary");
		});

		it("allows same messageId after drain (re-escalation across agent turns)", () => {
			const queue = new TapNotificationQueue();
			queue.push(makeNotification({ messageId: "dup", oneLiner: "first" }));
			queue.drain();

			queue.push(makeNotification({ messageId: "dup", oneLiner: "second" }));
			const items = queue.drain();
			expect(items).toHaveLength(1);
			expect(items[0]!.oneLiner).toBe("second");
		});
	});

	describe("eviction", () => {
		it("evicts oldest info item first when at capacity", () => {
			const queue = new TapNotificationQueue(5);

			const info1 = makeNotification({ messageId: "info-1", type: "info" });
			const info2 = makeNotification({ messageId: "info-2", type: "info" });
			const summary1 = makeNotification({ messageId: "summary-1", type: "summary" });
			const escalation1 = makeNotification({ messageId: "escalation-1", type: "escalation" });
			const escalation2 = makeNotification({ messageId: "escalation-2", type: "escalation" });

			queue.push(info1);
			queue.push(info2);
			queue.push(summary1);
			queue.push(escalation1);
			queue.push(escalation2);

			// Queue is at capacity (5). Push one more — should evict oldest info (info-1).
			const newItem = makeNotification({ messageId: "new-1", type: "summary" });
			queue.push(newItem);

			const items = queue.drain();
			expect(items).toHaveLength(5);
			const ids = items.map((n) => n.messageId);
			expect(ids).not.toContain("info-1");
			expect(ids).toContain("info-2");
			expect(ids).toContain("summary-1");
			expect(ids).toContain("escalation-1");
			expect(ids).toContain("escalation-2");
			expect(ids).toContain("new-1");
		});

		it("evicts oldest summary when no info items remain", () => {
			const queue = new TapNotificationQueue(3);

			const summary1 = makeNotification({ messageId: "summary-1", type: "summary" });
			const summary2 = makeNotification({ messageId: "summary-2", type: "summary" });
			const escalation1 = makeNotification({ messageId: "escalation-1", type: "escalation" });

			queue.push(summary1);
			queue.push(summary2);
			queue.push(escalation1);

			// Push one more — no info to evict, should evict oldest summary (summary-1).
			const newItem = makeNotification({ messageId: "new-1", type: "escalation" });
			queue.push(newItem);

			const items = queue.drain();
			expect(items).toHaveLength(3);
			const ids = items.map((n) => n.messageId);
			expect(ids).not.toContain("summary-1");
			expect(ids).toContain("summary-2");
			expect(ids).toContain("escalation-1");
			expect(ids).toContain("new-1");
		});

		it("never evicts escalation items, allowing overflow", () => {
			const queue = new TapNotificationQueue(3);

			const e1 = makeNotification({ messageId: "e-1", type: "escalation" });
			const e2 = makeNotification({ messageId: "e-2", type: "escalation" });
			const e3 = makeNotification({ messageId: "e-3", type: "escalation" });

			queue.push(e1);
			queue.push(e2);
			queue.push(e3);

			// Push another escalation — all are escalations so none can be evicted.
			const e4 = makeNotification({ messageId: "e-4", type: "escalation" });
			queue.push(e4);

			const items = queue.drain();
			expect(items).toHaveLength(4); // overflow allowed
			const ids = items.map((n) => n.messageId);
			expect(ids).toEqual(["e-1", "e-2", "e-3", "e-4"]);
		});

		it("evicts info before summary in mixed queue", () => {
			const queue = new TapNotificationQueue(5);

			// Fill with: info, summary, info, escalation, summary
			queue.push(makeNotification({ messageId: "info-1", type: "info" }));
			queue.push(makeNotification({ messageId: "summary-1", type: "summary" }));
			queue.push(makeNotification({ messageId: "info-2", type: "info" }));
			queue.push(makeNotification({ messageId: "escalation-1", type: "escalation" }));
			queue.push(makeNotification({ messageId: "summary-2", type: "summary" }));

			// Push triggers eviction — should evict info-1 (oldest info)
			queue.push(makeNotification({ messageId: "new-1", type: "info" }));

			let items = queue.drain();
			expect(items).toHaveLength(5);
			expect(items.map((n) => n.messageId)).not.toContain("info-1");
			expect(items.map((n) => n.messageId)).toContain("info-2");

			// Rebuild: remove info items to test summary eviction
			queue.push(makeNotification({ messageId: "summary-a", type: "summary" }));
			queue.push(makeNotification({ messageId: "summary-b", type: "summary" }));
			queue.push(makeNotification({ messageId: "summary-c", type: "summary" }));
			queue.push(makeNotification({ messageId: "escalation-a", type: "escalation" }));
			queue.push(makeNotification({ messageId: "escalation-b", type: "escalation" }));

			// Push triggers eviction — no info, evicts oldest summary (summary-a)
			queue.push(makeNotification({ messageId: "new-2", type: "escalation" }));

			items = queue.drain();
			expect(items).toHaveLength(5);
			expect(items.map((n) => n.messageId)).not.toContain("summary-a");
			expect(items.map((n) => n.messageId)).toContain("summary-b");
		});
	});
});
