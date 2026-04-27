import { createGrantSet } from "trusted-agents-core";
import { describe, expect, it } from "vitest";
import { filterPendingForContact } from "../../lib/pending.js";
import type { Contact, PendingItem } from "../../lib/types.js";

function makeContact(overrides: Partial<Contact> = {}): Contact {
	return {
		connectionId: "conn-1",
		peerAgentId: 42,
		peerChain: "eip155:8453",
		peerOwnerAddress: "0x1111111111111111111111111111111111111111",
		peerDisplayName: "Alice (Base)",
		peerAgentAddress: "0x2222222222222222222222222222222222222222",
		permissions: {
			grantedByMe: createGrantSet([], "2026-01-01T00:00:00Z"),
			grantedByPeer: createGrantSet([], "2026-01-01T00:00:00Z"),
		},
		establishedAt: "2026-01-01T00:00:00Z",
		lastContactAt: "2026-01-01T00:00:00Z",
		status: "active",
		...overrides,
	};
}

function makePending(overrides: Partial<PendingItem> = {}): PendingItem {
	return {
		requestId: "req-1",
		method: "action/request",
		peerAgentId: 42,
		peerChain: "eip155:8453",
		direction: "inbound",
		kind: "request",
		status: "pending",
		...overrides,
	};
}

describe("filterPendingForContact (F2.3)", () => {
	it("returns items matching both peerAgentId and peerChain", () => {
		const contact = makeContact();
		const items = [
			makePending({ requestId: "match" }),
			makePending({ requestId: "wrong-agent", peerAgentId: 99 }),
		];
		expect(filterPendingForContact(items, contact).map((i) => i.requestId)).toEqual(["match"]);
	});

	it("excludes items for the same peerAgentId on a different chain", () => {
		const baseContact = makeContact();
		const baseItem = makePending({ requestId: "base-req", peerChain: "eip155:8453" });
		const taikoItem = makePending({ requestId: "taiko-req", peerChain: "eip155:167000" });

		const filtered = filterPendingForContact([baseItem, taikoItem], baseContact);

		expect(filtered.map((i) => i.requestId)).toEqual(["base-req"]);
	});

	it("routes pending items to the correct thread across a cross-chain collision", () => {
		// Two contacts with the SAME peerAgentId but different chains.
		const baseContact = makeContact({
			connectionId: "conn-base",
			peerChain: "eip155:8453",
			peerDisplayName: "Alice (Base)",
		});
		const taikoContact = makeContact({
			connectionId: "conn-taiko",
			peerChain: "eip155:167000",
			peerDisplayName: "Alice (Taiko)",
		});
		const baseItem = makePending({ requestId: "base-req", peerChain: "eip155:8453" });
		const taikoItem = makePending({ requestId: "taiko-req", peerChain: "eip155:167000" });

		expect(
			filterPendingForContact([baseItem, taikoItem], baseContact).map((i) => i.requestId),
		).toEqual(["base-req"]);
		expect(
			filterPendingForContact([baseItem, taikoItem], taikoContact).map((i) => i.requestId),
		).toEqual(["taiko-req"]);
	});

	it("only returns action/request items (ignores other methods)", () => {
		const contact = makeContact();
		const items = [
			makePending({ requestId: "action", method: "action/request" }),
			makePending({ requestId: "conn", method: "connection/request" }),
			makePending({ requestId: "msg", method: "message/send" }),
		];
		expect(filterPendingForContact(items, contact).map((i) => i.requestId)).toEqual(["action"]);
	});

	it("fails closed on empty peerChain (unknown) rather than guessing", () => {
		const contact = makeContact();
		const items = [makePending({ requestId: "unknown-chain", peerChain: "" })];
		// Empty peerChain means core couldn't uniquely resolve the chain
		// for this entry. We deliberately exclude it from any thread
		// rather than speculatively matching by peerAgentId alone.
		expect(filterPendingForContact(items, contact)).toEqual([]);
	});

	it("returns an empty list when nothing matches", () => {
		expect(filterPendingForContact([], makeContact())).toEqual([]);
	});
});
