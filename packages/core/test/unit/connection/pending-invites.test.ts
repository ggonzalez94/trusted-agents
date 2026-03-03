import { describe, expect, it } from "vitest";
import { PendingInviteStore } from "../../../src/connection/pending-invites.js";

describe("PendingInviteStore", () => {
	it("should create and validate an invite", () => {
		const store = new PendingInviteStore();
		const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

		store.create("nonce-1", futureExpiry);

		expect(store.isValid("nonce-1")).toBe(true);
	});

	it("should return false for an unknown nonce", () => {
		const store = new PendingInviteStore();

		expect(store.isValid("unknown-nonce")).toBe(false);
	});

	it("should redeem an invite successfully", () => {
		const store = new PendingInviteStore();
		const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

		store.create("nonce-1", futureExpiry);

		const redeemed = store.redeem("nonce-1");
		expect(redeemed).toBe(true);
	});

	it("should fail to redeem an already-redeemed invite (double-redeem)", () => {
		const store = new PendingInviteStore();
		const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

		store.create("nonce-1", futureExpiry);

		expect(store.redeem("nonce-1")).toBe(true);
		expect(store.redeem("nonce-1")).toBe(false);
	});

	it("should fail to redeem a nonexistent nonce", () => {
		const store = new PendingInviteStore();

		expect(store.redeem("does-not-exist")).toBe(false);
	});

	it("should fail to redeem an expired invite", () => {
		const store = new PendingInviteStore();
		const pastExpiry = Math.floor(Date.now() / 1000) - 10;

		store.create("expired-nonce", pastExpiry);

		expect(store.redeem("expired-nonce")).toBe(false);
	});

	it("should mark expired invites as invalid", () => {
		const store = new PendingInviteStore();
		const pastExpiry = Math.floor(Date.now() / 1000) - 10;

		store.create("expired-nonce", pastExpiry);

		expect(store.isValid("expired-nonce")).toBe(false);
	});

	it("should clean up expired invites", () => {
		const store = new PendingInviteStore();
		const pastExpiry = Math.floor(Date.now() / 1000) - 10;
		const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

		store.create("expired-1", pastExpiry);
		store.create("valid-1", futureExpiry);

		store.cleanup();

		// After cleanup, the expired nonce should be gone entirely
		expect(store.isValid("expired-1")).toBe(false);
		expect(store.isValid("valid-1")).toBe(true);
	});
});
