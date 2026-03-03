export interface InviteData {
	agentId: number;
	chain: string;
	nonce: string;
	expires: number;
	signature: `0x${string}`;
}

export type InviteStatus = "unused" | "redeemed" | "expired";

export interface PendingInvite {
	nonce: string;
	status: InviteStatus;
	createdAt: string;
	expiresAt: number;
}
