import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFileOrDefault, writeJsonFileAtomic } from "../common/atomic-json.js";
import {
	AsyncMutex,
	assertPathWithinBase,
	assertSafeFileComponent,
	resolveDataDir,
} from "../common/index.js";
import { legacyConversationsDir } from "./paths.js";
import { generateMarkdownTranscript } from "./transcript.js";
import type { ConversationLog, ConversationMessage } from "./types.js";

interface ConversationContext {
	connectionId: string;
	peerAgentId: number;
	peerDisplayName: string;
	topic?: string;
}

export interface IConversationLogger {
	logMessage(
		conversationId: string,
		message: ConversationMessage,
		context?: ConversationContext,
	): Promise<void>;
	getConversation(conversationId: string): Promise<ConversationLog | null>;
	listConversations(filter?: { connectionId?: string }): Promise<ConversationLog[]>;
	generateTranscript(conversationId: string): Promise<string>;
	markRead(conversationId: string, readAt: string): Promise<void>;
}

export class FileConversationLogger implements IConversationLogger {
	private readonly conversationsDir: string;
	private readonly writeMutex = new AsyncMutex();

	constructor(dataDir: string = join(process.env.HOME ?? "~", ".trustedagents")) {
		this.dataDir = resolveDataDir(dataDir);
		this.conversationsDir = legacyConversationsDir(this.dataDir);
	}
	private readonly dataDir: string;

	async logMessage(
		conversationId: string,
		message: ConversationMessage,
		context?: ConversationContext,
	): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const log = await this.loadLog(conversationId);

			if (log) {
				if (
					typeof message.messageId === "string" &&
					log.messages.some(
						(entry) =>
							entry.messageId === message.messageId && entry.direction === message.direction,
					)
				) {
					return;
				}

				log.messages.push(message);
				log.lastMessageAt = message.timestamp;
				if (context?.topic) {
					log.topic = context.topic;
				}
				await this.saveLog(conversationId, log);
				return;
			}

			if (!context) {
				throw new Error("context is required when creating a new conversation log entry");
			}

			const newLog: ConversationLog = {
				conversationId,
				connectionId: context.connectionId,
				peerAgentId: context.peerAgentId,
				peerDisplayName: context.peerDisplayName,
				...(context.topic ? { topic: context.topic } : {}),
				startedAt: message.timestamp,
				lastMessageAt: message.timestamp,
				status: "active",
				messages: [message],
			};
			await this.saveLog(conversationId, newLog);
		});
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
			const log = await readJsonFileOrDefault(
				filePath,
				(raw) => normalizeConversationLog(raw as ConversationLog),
				null,
				{ fallbackOnError: true },
			);
			if (!log || (filter?.connectionId && log.connectionId !== filter.connectionId)) {
				continue;
			}
			logs.push(log);
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

	async markRead(conversationId: string, readAt: string): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const log = await this.loadLog(conversationId);
			if (!log) return;
			log.lastReadAt = readAt;
			await this.saveLog(conversationId, log);
		});
	}

	private async loadLog(conversationId: string): Promise<ConversationLog | null> {
		const filePath = this.filePathForConversation(conversationId);
		return readJsonFileOrDefault(
			filePath,
			(raw) => normalizeConversationLog(raw as ConversationLog),
			null,
		);
	}

	private async saveLog(conversationId: string, log: ConversationLog): Promise<void> {
		const filePath = this.filePathForConversation(conversationId);
		await writeJsonFileAtomic(filePath, log, {
			directoryMode: 0o700,
			tempPrefix: ".conversation",
		});
	}

	private filePathForConversation(conversationId: string): string {
		assertSafeFileComponent(conversationId, "conversationId");
		const filePath = join(this.conversationsDir, `${conversationId}.json`);
		assertPathWithinBase(this.conversationsDir, filePath, "conversationId");
		return filePath;
	}
}

function normalizeConversationLog(log: ConversationLog): ConversationLog {
	const messages = [...log.messages].sort((left, right) =>
		left.timestamp.localeCompare(right.timestamp),
	);
	const startedAt = messages[0]?.timestamp ?? log.startedAt;
	const lastMessageAt = messages[messages.length - 1]?.timestamp ?? log.lastMessageAt;

	return {
		...log,
		messages,
		startedAt,
		lastMessageAt,
	};
}
