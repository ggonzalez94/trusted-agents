import type { ContactPermissionState } from "../permissions/types.js";

export type ConnectionStatus = "connecting" | "active" | "idle" | "stale" | "revoked";

export interface Contact {
	connectionId: string;
	peerAgentId: number;
	peerChain: string;
	peerOwnerAddress: `0x${string}`;
	peerDisplayName: string;
	peerAgentAddress: `0x${string}`;
	permissions: ContactPermissionState;
	establishedAt: string;
	lastContactAt: string;
	status: ConnectionStatus;
	/** ISO timestamp from the invite's `expires` field. Display-only hint for connecting contacts; not used for expiry logic. */
	expiresAt?: string;
}

export interface ContactsFile {
	contacts: Contact[];
}

/** Format a peer identifier as "DisplayName (#agentId)" for logs and ledger entries. */
export function peerLabel(peer: { peerDisplayName: string; peerAgentId: number }): string {
	return `${peer.peerDisplayName} (#${peer.peerAgentId})`;
}
