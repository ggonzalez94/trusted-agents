import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { resolveDataDir } from "../common/index.js";
import type { IConversationLogger } from "./logger.js";
import { applySchema } from "./sqlite-schema.js";
import { generateMarkdownTranscript } from "./transcript.js";
import type { ConversationLog, ConversationMessage } from "./types.js";

interface ConversationContext {
	connectionId: string;
	peerAgentId: number;
	peerDisplayName: string;
	topic?: string;
}

interface ConversationRow {
	conversation_id: string;
	connection_id: string;
	peer_agent_id: number;
	peer_display_name: string;
	topic: string | null;
	started_at: string;
	last_message_at: string;
	last_read_at: string | null;
	status: "active" | "completed" | "archived";
}

interface MessageRow {
	message_id: string | null;
	timestamp: string;
	direction: "incoming" | "outgoing";
	scope: string;
	content: string;
	human_approval_required: number;
	human_approval_given: number | null;
	human_approval_at: string | null;
}

export class SqliteConversationLogger implements IConversationLogger {
	private readonly db: Database.Database;
	private readonly dataDir: string;
	private closed = false;

	private readonly stmtSelectConversation: Database.Statement;
	private readonly stmtInsertConversation: Database.Statement;
	private readonly stmtUpdateConversationOnAppend: Database.Statement;
	private readonly stmtFindDupMessage: Database.Statement;
	private readonly stmtCountMessages: Database.Statement;
	private readonly stmtInsertMessage: Database.Statement;
	private readonly stmtSelectMessages: Database.Statement;
	private readonly stmtListAllConversations: Database.Statement;
	private readonly stmtListConversationsByConnection: Database.Statement;
	private readonly stmtMarkRead: Database.Statement;

	constructor(dataDir: string) {
		this.dataDir = resolveDataDir(dataDir);
		mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		this.db = new Database(join(this.dataDir, "conversations.db"));
		applySchema(this.db);

		this.stmtSelectConversation = this.db.prepare(
			"SELECT * FROM conversations WHERE conversation_id = ?",
		);
		this.stmtInsertConversation = this.db.prepare(
			`INSERT INTO conversations(
				conversation_id, connection_id, peer_agent_id, peer_display_name,
				topic, started_at, last_message_at, last_read_at, status
			) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active')`,
		);
		this.stmtUpdateConversationOnAppend = this.db.prepare(
			`UPDATE conversations
			 SET last_message_at = ?, topic = COALESCE(?, topic)
			 WHERE conversation_id = ?`,
		);
		this.stmtFindDupMessage = this.db.prepare(
			`SELECT 1 FROM messages
			 WHERE conversation_id = ? AND message_id = ? AND direction = ?
			 LIMIT 1`,
		);
		this.stmtCountMessages = this.db.prepare(
			"SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?",
		);
		this.stmtInsertMessage = this.db.prepare(
			`INSERT INTO messages(
				conversation_id, message_id, timestamp, direction, scope, content,
				human_approval_required, human_approval_given, human_approval_at, insert_order
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.stmtSelectMessages = this.db.prepare(
			`SELECT message_id, timestamp, direction, scope, content,
			        human_approval_required, human_approval_given, human_approval_at
			 FROM messages
			 WHERE conversation_id = ?
			 ORDER BY timestamp ASC, insert_order ASC`,
		);
		this.stmtListAllConversations = this.db.prepare(
			"SELECT * FROM conversations ORDER BY last_message_at DESC",
		);
		this.stmtListConversationsByConnection = this.db.prepare(
			`SELECT * FROM conversations
			 WHERE connection_id = ?
			 ORDER BY last_message_at DESC`,
		);
		this.stmtMarkRead = this.db.prepare(
			"UPDATE conversations SET last_read_at = ? WHERE conversation_id = ?",
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	get database(): Database.Database {
		return this.db;
	}

	async logMessage(
		conversationId: string,
		message: ConversationMessage,
		context?: ConversationContext,
	): Promise<void> {
		const insert = this.db.transaction(() => {
			const existing = this.stmtSelectConversation.get(conversationId) as
				| ConversationRow
				| undefined;

			if (!existing) {
				if (!context) {
					throw new Error(
						"context is required when creating a new conversation log entry",
					);
				}
				this.stmtInsertConversation.run(
					conversationId,
					context.connectionId,
					context.peerAgentId,
					context.peerDisplayName,
					context.topic ?? null,
					message.timestamp,
					message.timestamp,
				);
			} else {
				if (typeof message.messageId === "string") {
					const dup = this.stmtFindDupMessage.get(
						conversationId,
						message.messageId,
						message.direction,
					);
					if (dup) return;
				}

				this.stmtUpdateConversationOnAppend.run(
					message.timestamp,
					context?.topic ?? null,
					conversationId,
				);
			}

			const count = this.stmtCountMessages.get(conversationId) as { c: number };
			const insertOrder = count.c + 1;

			this.stmtInsertMessage.run(
				conversationId,
				message.messageId ?? null,
				message.timestamp,
				message.direction,
				message.scope,
				message.content,
				message.humanApprovalRequired ? 1 : 0,
				message.humanApprovalGiven === null ? null : message.humanApprovalGiven ? 1 : 0,
				message.humanApprovalAt ?? null,
				insertOrder,
			);
		});

		insert();
	}

	async getConversation(conversationId: string): Promise<ConversationLog | null> {
		const row = this.stmtSelectConversation.get(conversationId) as
			| ConversationRow
			| undefined;
		if (!row) return null;

		const messageRows = this.stmtSelectMessages.all(conversationId) as MessageRow[];
		return rowToConversationLog(row, messageRows);
	}

	async listConversations(filter?: {
		connectionId?: string;
	}): Promise<ConversationLog[]> {
		const rows = filter?.connectionId
			? (this.stmtListConversationsByConnection.all(filter.connectionId) as ConversationRow[])
			: (this.stmtListAllConversations.all() as ConversationRow[]);

		const result: ConversationLog[] = [];
		for (const row of rows) {
			const messages = this.stmtSelectMessages.all(row.conversation_id) as MessageRow[];
			result.push(rowToConversationLog(row, messages));
		}
		return result;
	}

	async generateTranscript(conversationId: string): Promise<string> {
		const log = await this.getConversation(conversationId);
		if (!log) return "";
		return generateMarkdownTranscript(log);
	}

	async markRead(conversationId: string, readAt: string): Promise<void> {
		this.stmtMarkRead.run(readAt, conversationId);
	}
}

function rowToConversationLog(
	row: ConversationRow,
	messages: MessageRow[],
): ConversationLog {
	return {
		conversationId: row.conversation_id,
		connectionId: row.connection_id,
		peerAgentId: row.peer_agent_id,
		peerDisplayName: row.peer_display_name,
		...(row.topic ? { topic: row.topic } : {}),
		startedAt: row.started_at,
		lastMessageAt: row.last_message_at,
		...(row.last_read_at ? { lastReadAt: row.last_read_at } : {}),
		status: row.status,
		messages: messages.map(rowToMessage),
	};
}

function rowToMessage(row: MessageRow): ConversationMessage {
	return {
		...(row.message_id ? { messageId: row.message_id } : {}),
		timestamp: row.timestamp,
		direction: row.direction,
		scope: row.scope,
		content: row.content,
		humanApprovalRequired: row.human_approval_required === 1,
		humanApprovalGiven:
			row.human_approval_given === null ? null : row.human_approval_given === 1,
		...(row.human_approval_at ? { humanApprovalAt: row.human_approval_at } : {}),
	};
}
