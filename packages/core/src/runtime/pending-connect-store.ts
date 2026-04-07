import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncMutex, fsErrorCode, resolveDataDir } from "../common/index.js";

interface PendingConnectsFile {
	pendingConnects: PendingConnectRecord[];
}

export interface PendingConnectRecord {
	requestId: string;
	peerAgentId: number;
	peerChain: string;
	peerOwnerAddress: `0x${string}`;
	peerDisplayName: string;
	peerAgentAddress: `0x${string}`;
	createdAt: string;
}

export class FilePendingConnectStore {
	private readonly dataDir: string;
	private readonly path: string;
	private readonly writeMutex = new AsyncMutex();

	constructor(dataDir = join(process.env.HOME ?? "~", ".trustedagents")) {
		this.dataDir = resolveDataDir(dataDir);
		this.path = join(this.dataDir, "pending-connects.json");
	}

	async get(requestId: string): Promise<PendingConnectRecord | null> {
		const file = await this.load();
		return file.pendingConnects.find((entry) => entry.requestId === requestId) ?? null;
	}

	async delete(requestId: string): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			const filtered = file.pendingConnects.filter((entry) => entry.requestId !== requestId);
			if (filtered.length === file.pendingConnects.length) {
				return;
			}
			await this.save({ pendingConnects: filtered });
		});
	}

	async replaceForPeer(record: PendingConnectRecord): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			file.pendingConnects = [
				...file.pendingConnects.filter(
					(entry) =>
						(entry.peerAgentId !== record.peerAgentId || entry.peerChain !== record.peerChain) &&
						entry.requestId !== record.requestId,
				),
				record,
			];
			await this.save(file);
		});
	}

	private async load(): Promise<PendingConnectsFile> {
		try {
			const raw = await readFile(this.path, "utf-8");
			const parsed = JSON.parse(raw) as PendingConnectsFile;
			return Array.isArray(parsed.pendingConnects) ? parsed : { pendingConnects: [] };
		} catch (error: unknown) {
			if (fsErrorCode(error) === "ENOENT") {
				return { pendingConnects: [] };
			}
			throw error;
		}
	}

	private async save(file: PendingConnectsFile): Promise<void> {
		await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		const tmpPath = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, JSON.stringify(file, null, "\t"), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmpPath, this.path);
	}
}
