import type { Contact, PendingItem } from "./types.js";

/**
 * Filter pending items for a specific contact's thread (F2.3).
 *
 * The canonical peer identity in core is `(peerAgentId, peerChain)`.
 * Agent IDs are numeric token IDs from ERC-8004 and can collide across
 * chains — a Base agent #42 and a Taiko agent #42 are two distinct
 * peers. Matching on `peerAgentId` alone can route a pending approval
 * to the wrong thread and the operator can approve against the wrong
 * counterparty.
 *
 * We fail closed on unknown chain: if a pending item has an empty
 * `peerChain` (core couldn't uniquely resolve it from the journal
 * entry's metadata or the trust store), we deliberately exclude it
 * from any thread's pending cards rather than speculatively attaching
 * it to the thread that happens to share `peerAgentId`.
 */
export function filterPendingForContact(
	pending: readonly PendingItem[],
	contact: Pick<Contact, "peerAgentId" | "peerChain">,
): PendingItem[] {
	return pending.filter(
		(item) =>
			item.method === "action/request" &&
			item.peerAgentId === contact.peerAgentId &&
			item.peerChain.length > 0 &&
			item.peerChain === contact.peerChain,
	);
}
