import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncMutex, isExpired, nowISO, resolveDataDir } from "../common/index.js";
import type { PendingInvite } from "./types.js";

interface PendingInvitesFile {
	invites: PendingInvite[];
}

export interface IPendingInviteStore {
	create(nonce: string, expiresAt: number): Promise<void> | void;
	redeem(nonce: string): Promise<boolean> | boolean;
	isValid(nonce: string): Promise<boolean> | boolean;
	cleanup(): Promise<void> | void;
}

export class PendingInviteStore implements IPendingInviteStore {
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

export class FilePendingInviteStore implements IPendingInviteStore {
	private readonly dataDir: string;
	private readonly path: string;
	private readonly writeMutex = new AsyncMutex();

	constructor(dataDir = join(process.env.HOME ?? "~", ".trustedagents")) {
		this.dataDir = resolveDataDir(dataDir);
		this.path = join(this.dataDir, "pending-invites.json");
	}

	async create(nonce: string, expiresAt: number): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			const existing = file.invites.find((i) => i.nonce === nonce);
			if (existing && existing.status === "redeemed") {
				return;
			}
			const pending: PendingInvite = {
				nonce,
				status: "unused",
				createdAt: nowISO(),
				expiresAt,
			};
			const filtered = file.invites.filter((i) => i.nonce !== nonce);
			filtered.push(pending);
			await this.save({ invites: filtered });
		});
	}

	async redeem(nonce: string): Promise<boolean> {
		return this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			const invite = file.invites.find((i) => i.nonce === nonce);
			if (!invite) {
				return false;
			}
			if (invite.status !== "unused") {
				return false;
			}
			if (isExpired(invite.expiresAt)) {
				invite.status = "expired";
				await this.save(file);
				return false;
			}
			invite.status = "redeemed";
			await this.save(file);
			return true;
		});
	}

	async isValid(nonce: string): Promise<boolean> {
		const file = await this.load();
		const invite = file.invites.find((i) => i.nonce === nonce);
		if (!invite || invite.status !== "unused") {
			return false;
		}
		return !isExpired(invite.expiresAt);
	}

	async cleanup(): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			const filtered = file.invites.filter((i) => !isExpired(i.expiresAt));
			await this.save({ invites: filtered });
		});
	}

	private async load(): Promise<PendingInvitesFile> {
		try {
			const raw = await readFile(this.path, "utf-8");
			const parsed = JSON.parse(raw) as PendingInvitesFile;
			return Array.isArray(parsed.invites) ? parsed : { invites: [] };
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return { invites: [] };
			}
			throw err;
		}
	}

	private async save(file: PendingInvitesFile): Promise<void> {
		await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		const tmpPath = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, JSON.stringify(file, null, "\t"), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmpPath, this.path);
	}
}
