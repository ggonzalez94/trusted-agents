import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataDir } from "../common/index.js";

export interface TransportOwnerInfo {
	pid: number;
	owner: string;
	acquiredAt: string;
}

export class TransportOwnershipError extends Error {
	constructor(
		message: string,
		public readonly currentOwner?: TransportOwnerInfo,
	) {
		super(message);
		this.name = "TransportOwnershipError";
	}
}

export class TransportOwnerLock {
	private readonly lockPath: string;
	private held = false;

	constructor(
		dataDir: string,
		private readonly owner: string,
	) {
		this.lockPath = join(resolveDataDir(dataDir), ".transport.lock");
	}

	async acquire(): Promise<void> {
		if (this.held) {
			return;
		}

		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const handle = await open(this.lockPath, "wx", 0o600);
				try {
					const payload: TransportOwnerInfo = {
						pid: process.pid,
						owner: this.owner,
						acquiredAt: new Date().toISOString(),
					};
					await handle.writeFile(JSON.stringify(payload, null, "\t"), "utf-8");
					this.held = true;
					return;
				} finally {
					await handle.close();
				}
			} catch (error: unknown) {
				const code =
					error instanceof Error && "code" in error
						? (error as NodeJS.ErrnoException).code
						: undefined;
				if (code !== "EEXIST") {
					throw error;
				}

				const currentOwner = await this.readOwner();
				if (currentOwner && isProcessAlive(currentOwner.pid)) {
					throw new TransportOwnershipError(
						`TAP transport is already owned by ${currentOwner.owner} (pid ${currentOwner.pid}) for this data dir`,
						currentOwner,
					);
				}

				await rm(this.lockPath, { force: true });
			}
		}

		const currentOwner = await this.readOwner();
		throw new TransportOwnershipError(
			"Failed to acquire TAP transport ownership lock",
			currentOwner ?? undefined,
		);
	}

	async release(): Promise<void> {
		if (!this.held) {
			return;
		}
		this.held = false;
		await rm(this.lockPath, { force: true });
	}

	async inspect(): Promise<TransportOwnerInfo | null> {
		return await this.readOwner();
	}

	private async readOwner(): Promise<TransportOwnerInfo | null> {
		try {
			const raw = await readFile(this.lockPath, "utf-8");
			const parsed = JSON.parse(raw) as Partial<TransportOwnerInfo>;
			if (
				typeof parsed.pid === "number" &&
				typeof parsed.owner === "string" &&
				typeof parsed.acquiredAt === "string"
			) {
				return {
					pid: parsed.pid,
					owner: parsed.owner,
					acquiredAt: parsed.acquiredAt,
				};
			}
			return null;
		} catch (error: unknown) {
			const code =
				error instanceof Error && "code" in error
					? (error as NodeJS.ErrnoException).code
					: undefined;
			if (code === "ENOENT") {
				return null;
			}
			throw error;
		}
	}
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}

	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "EPERM") {
			return true;
		}
		return false;
	}
}
