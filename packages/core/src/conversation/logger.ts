import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateMarkdownTranscript } from "./transcript.js";
import type { ConversationLog, ConversationMessage } from "./types.js";

export interface IConversationLogger {
	logMessage(conversationId: string, message: ConversationMessage): Promise<void>;
	getConversation(conversationId: string): Promise<ConversationLog | null>;
	listConversations(filter?: { connectionId?: string }): Promise<ConversationLog[]>;
	generateTranscript(conversationId: string): Promise<string>;
}

export class FileConversationLogger implements IConversationLogger {
	private readonly conversationsDir: string;

	constructor(private readonly dataDir: string = join(process.env.HOME ?? "~", ".trustedagents")) {
		this.conversationsDir = join(this.dataDir, "conversations");
	}

	async logMessage(conversationId: string, message: ConversationMessage): Promise<void> {
		const log = await this.loadLog(conversationId);

		if (log) {
			log.messages.push(message);
			log.lastMessageAt = message.timestamp;
			await this.saveLog(conversationId, log);
		} else {
			const newLog: ConversationLog = {
				conversationId,
				connectionId: "",
				peerAgentId: 0,
				peerDisplayName: "Unknown",
				startedAt: message.timestamp,
				lastMessageAt: message.timestamp,
				status: "active",
				messages: [message],
			};
			await this.saveLog(conversationId, newLog);
		}
	}

	async getConversation(conversationId: string): Promise<ConversationLog | null> {
		return this.loadLog(conversationId);
	}

	async listConversations(filter?: { connectionId?: string }): Promise<ConversationLog[]> {
		await mkdir(this.conversationsDir, { recursive: true });

		let entries: string[];
		try {
			entries = await readdir(this.conversationsDir);
		} catch {
			return [];
		}

		const logs: ConversationLog[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const filePath = join(this.conversationsDir, entry);
			try {
				const raw = await readFile(filePath, "utf-8");
				const log = JSON.parse(raw) as ConversationLog;
				if (filter?.connectionId && log.connectionId !== filter.connectionId) {
					continue;
				}
				logs.push(log);
			} catch {
				// Skip corrupted files
			}
		}

		return logs;
	}

	async generateTranscript(conversationId: string): Promise<string> {
		const log = await this.loadLog(conversationId);
		if (!log) {
			return "";
		}
		return generateMarkdownTranscript(log);
	}

	private async loadLog(conversationId: string): Promise<ConversationLog | null> {
		const filePath = join(this.conversationsDir, `${conversationId}.json`);
		try {
			const raw = await readFile(filePath, "utf-8");
			return JSON.parse(raw) as ConversationLog;
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return null;
			}
			throw err;
		}
	}

	private async saveLog(conversationId: string, log: ConversationLog): Promise<void> {
		await mkdir(this.conversationsDir, { recursive: true });
		const filePath = join(this.conversationsDir, `${conversationId}.json`);
		const tmpPath = `${filePath}.tmp`;
		await writeFile(tmpPath, JSON.stringify(log, null, "\t"), "utf-8");
		await rename(tmpPath, filePath);
	}
}
