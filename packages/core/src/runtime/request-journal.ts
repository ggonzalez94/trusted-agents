import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncMutex, nowISO, resolveDataDir } from "../common/index.js";

export type RequestJournalDirection = "inbound" | "outbound";
export type RequestJournalKind = "request" | "result";
export type RequestJournalStatus = "pending" | "acked" | "completed";
export type RequestJournalMetadata = Record<string, unknown>;

export interface RequestJournalEntry {
	requestId: string;
	requestKey: string;
	direction: RequestJournalDirection;
	kind: RequestJournalKind;
	method: string;
	peerAgentId: number;
	correlationId?: string;
	status: RequestJournalStatus;
	metadata?: RequestJournalMetadata;
	createdAt: string;
	updatedAt: string;
}

interface RequestJournalFile {
	entries: RequestJournalEntry[];
}

export interface IRequestJournal {
	claimInbound(
		entry: Omit<RequestJournalEntry, "createdAt" | "updatedAt" | "status"> & {
			status?: RequestJournalStatus;
		},
	): Promise<{ duplicate: boolean; entry: RequestJournalEntry }>;
	putOutbound(
		entry: Omit<RequestJournalEntry, "createdAt" | "updatedAt">,
	): Promise<RequestJournalEntry>;
	getByRequestId(requestId: string): Promise<RequestJournalEntry | null>;
	delete(requestId: string): Promise<void>;
	updateStatus(requestId: string, status: RequestJournalStatus): Promise<void>;
	updateMetadata(requestId: string, metadata: RequestJournalMetadata | undefined): Promise<void>;
	listPending(direction?: RequestJournalDirection): Promise<RequestJournalEntry[]>;
}

export class FileRequestJournal implements IRequestJournal {
	private readonly path: string;
	private readonly writeMutex = new AsyncMutex();

	constructor(dataDir = join(process.env.HOME ?? "~", ".trustedagents")) {
		this.dataDir = resolveDataDir(dataDir);
		this.path = join(this.dataDir, "request-journal.json");
	}

	private readonly dataDir: string;

	async claimInbound(
		entry: Omit<RequestJournalEntry, "createdAt" | "updatedAt" | "status"> & {
			status?: RequestJournalStatus;
		},
	): Promise<{ duplicate: boolean; entry: RequestJournalEntry }> {
		return this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			const existing = file.entries.find((candidate) => candidate.requestKey === entry.requestKey);
			if (existing) {
				return { duplicate: true, entry: existing };
			}

			const timestamp = nowISO();
			const created: RequestJournalEntry = {
				...entry,
				status: entry.status ?? "pending",
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			file.entries.push(created);
			await this.save(file);
			return { duplicate: false, entry: created };
		});
	}

	async putOutbound(
		entry: Omit<RequestJournalEntry, "createdAt" | "updatedAt">,
	): Promise<RequestJournalEntry> {
		return this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			const normalized = this.upsertOutboundEntry(file, entry);
			await this.save(file);
			return normalized;
		});
	}

	async getByRequestId(requestId: string): Promise<RequestJournalEntry | null> {
		const file = await this.load();
		return file.entries.find((entry) => entry.requestId === requestId) ?? null;
	}

	async delete(requestId: string): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			const filtered = file.entries.filter((entry) => entry.requestId !== requestId);
			if (filtered.length === file.entries.length) {
				return;
			}
			await this.save({ entries: filtered });
		});
	}

	async updateStatus(requestId: string, status: RequestJournalStatus): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			const index = file.entries.findIndex((entry) => entry.requestId === requestId);
			if (index < 0) {
				return;
			}
			file.entries[index] = {
				...file.entries[index]!,
				status,
				updatedAt: nowISO(),
			};
			await this.save(file);
		});
	}

	async updateMetadata(
		requestId: string,
		metadata: RequestJournalMetadata | undefined,
	): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const file = await this.load();
			const index = file.entries.findIndex((entry) => entry.requestId === requestId);
			if (index < 0) {
				return;
			}
			file.entries[index] = {
				...file.entries[index]!,
				metadata,
				updatedAt: nowISO(),
			};
			await this.save(file);
		});
	}

	async listPending(direction?: RequestJournalDirection): Promise<RequestJournalEntry[]> {
		const file = await this.load();
		return file.entries.filter(
			(entry) =>
				entry.status !== "completed" && (direction === undefined || entry.direction === direction),
		);
	}

	private async load(): Promise<RequestJournalFile> {
		try {
			const raw = await readFile(this.path, "utf-8");
			const parsed = JSON.parse(raw) as RequestJournalFile;
			return Array.isArray(parsed.entries) ? parsed : { entries: [] };
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return { entries: [] };
			}
			throw err;
		}
	}

	private async save(file: RequestJournalFile): Promise<void> {
		await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		const tmpPath = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, JSON.stringify(file, null, "\t"), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmpPath, this.path);
	}

	private upsertOutboundEntry(
		file: RequestJournalFile,
		entry: Omit<RequestJournalEntry, "createdAt" | "updatedAt">,
	): RequestJournalEntry {
		const timestamp = nowISO();
		const existingIndex = file.entries.findIndex(
			(candidate) => candidate.requestId === entry.requestId,
		);
		const normalized: RequestJournalEntry = {
			...entry,
			createdAt: existingIndex >= 0 ? file.entries[existingIndex]!.createdAt : timestamp,
			updatedAt: timestamp,
		};

		if (existingIndex >= 0) {
			file.entries[existingIndex] = normalized;
		} else {
			file.entries.push(normalized);
		}

		return normalized;
	}
}
