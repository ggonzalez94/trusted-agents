import type { PermissionGrantSet } from "../permissions/types.js";
import type { ContactPermissionState } from "../permissions/types.js";

export type ConnectionStatus = "active" | "idle" | "stale" | "revoked" | "pending";

export interface PendingConnectionState {
	direction: "inbound" | "outbound";
	requestId: string;
	requestNonce: string;
	requestedAt: string;
	inviteNonce?: string;
	initialRequestedGrants?: PermissionGrantSet;
	initialOfferedGrants?: PermissionGrantSet;
}

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
	pending?: PendingConnectionState;
}

export interface ContactsFile {
	contacts: Contact[];
}
