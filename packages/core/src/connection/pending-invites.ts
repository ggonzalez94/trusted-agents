import { isExpired, nowISO } from "../common/index.js";
import type { PendingInvite } from "./types.js";

export class PendingInviteStore {
	private invites = new Map<string, PendingInvite>();

	create(nonce: string, expiresAt: number): void {
		this.invites.set(nonce, {
			nonce,
			status: "unused",
			createdAt: nowISO(),
			expiresAt,
		});
	}

	redeem(nonce: string): boolean {
		const invite = this.invites.get(nonce);
		if (!invite) return false;
		if (invite.status !== "unused") return false;
		if (isExpired(invite.expiresAt)) {
			invite.status = "expired";
			return false;
		}
		invite.status = "redeemed";
		return true;
	}

	isValid(nonce: string): boolean {
		const invite = this.invites.get(nonce);
		if (!invite) return false;
		if (invite.status !== "unused") return false;
		if (isExpired(invite.expiresAt)) {
			invite.status = "expired";
			return false;
		}
		return true;
	}

	cleanup(): void {
		for (const [nonce, invite] of this.invites) {
			if (isExpired(invite.expiresAt)) {
				this.invites.delete(nonce);
			}
		}
	}
}
