export type ConnectionStatus = "active" | "revoked" | "pending";

export interface Contact {
	connectionId: string;
	peerAgentId: number;
	peerChain: string;
	peerOwnerAddress: `0x${string}`;
	peerDisplayName: string;
	peerEndpoint: string;
	peerAgentAddress: `0x${string}`;
	permissions: Record<string, boolean | Record<string, unknown>>;
	establishedAt: string;
	lastContactAt: string;
	status: ConnectionStatus;
}

export interface ContactsFile {
	contacts: Contact[];
}
