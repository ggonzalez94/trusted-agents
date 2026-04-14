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
	private readonly stmtImportUpdateMetadata: Database.Statement;

	constructor(dataDir: string) {
		this.dataDir = resolveDataDir(dataDir);
		mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		this.db = new Database(join(this.dataDir, "conversations.db"));
		applySchema(this.db);

		this.stmtSelectConversation = this.db.prepare(
			"SELECT * FROM conversations WHERE conversation_id = ?",
		);
		// INSERT OR IGNORE keeps `importLog` idempotent against any pre-existing
		// conversation row (e.g. a pre-residual-2 partial migration that landed
		// a row before the fix). The regular logMessage path already guards
		// with a SELECT so the OR IGNORE is a no-op for that caller.
		this.stmtInsertConversation = this.db.prepare(
			`INSERT OR IGNORE INTO conversations(
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
		this.stmtImportUpdateMetadata = this.db.prepare(
			`UPDATE conversations
			 SET topic = ?, started_at = ?, last_message_at = ?, last_read_at = ?, status = ?
			 WHERE conversation_id = ?`,
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
					throw new Error("context is required when creating a new conversation log entry");
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
		const row = this.stmtSelectConversation.get(conversationId) as ConversationRow | undefined;
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

	/**
	 * Atomically import a full {@link ConversationLog} as a single transaction.
	 *
	 * This is the migration-safe path: the whole operation (conversation row
	 * INSERT OR IGNORE + canonical metadata UPDATE + per-message dedup-and-insert)
	 * runs inside one `better-sqlite3` transaction, so a failure partway through
	 * rolls back everything. Unlike calling {@link logMessage} in a loop — which
	 * wraps each message in its own sub-transaction and leaks partial state on
	 * mid-file errors — `importLog` gives the caller all-or-nothing semantics.
	 *
	 * **Message validation**: every message in `log.messages` is pre-validated
	 * (shape check) before any INSERT lands, so a malformed row late in the
	 * array cannot leave earlier rows committed. Validation throws before the
	 * transaction opens; callers should catch and record the error per-file.
	 *
	 * **Canonical metadata**: the conversation row is populated with
	 * `startedAt`, `lastMessageAt`, `lastReadAt`, `topic`, and `status` from
	 * the source log — NOT derived from message timestamps. Legacy logs that
	 * were not chronologically sorted on disk retain their authoritative
	 * summary fields after import.
	 *
	 * Synchronous on purpose — `better-sqlite3` transactions must be
	 * synchronous, and the migration calls this in a sync context.
	 */
	importLog(log: ConversationLog): void {
		if (this.closed) {
			throw new Error("cannot importLog into a closed SqliteConversationLogger");
		}
		validateConversationLogForImport(log);

		// Sort messages ascending by timestamp so `insert_order` increments
		// monotonically. Legacy FileConversationLogger sorted on read, so
		// disk order is not a guarantee (finding Fv2.2).
		const sortedMessages = [...log.messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

		const importFn = this.db.transaction(() => {
			// INSERT OR IGNORE — returns `changes: 1` when a fresh row was
			// created and `changes: 0` when the row already existed. The
			// change count is the gate that decides whether we overwrite
			// canonical metadata from the legacy log (below).
			const insertInfo = this.stmtInsertConversation.run(
				log.conversationId,
				log.connectionId,
				log.peerAgentId,
				log.peerDisplayName,
				log.topic ?? null,
				log.startedAt,
				log.lastMessageAt,
			);

			// Canonical metadata write is ONLY safe on a fresh insert. If
			// the conversation row already existed, it was put there by one
			// of two paths:
			//   (a) a previous migration attempt on this same file that
			//       failed partway and left the row behind. The new import
			//       transaction would have rolled that back, but we can
			//       still hit this case when a pre-residual-2 install
			//       landed partial state before the fix, or when runtime
			//       activity touched the conversation between a failed
			//       first-attempt and a successful retry.
			//   (b) the normal runtime append path (logMessage) mutated
			//       the row between a failed migration attempt and a
			//       later successful retry on the fixed legacy file.
			//
			// In either case, the existing row's metadata is either stale
			// (case a — but identical to what we'd write, so harmless to
			// keep) or newer than the legacy JSON (case b — overwriting
			// would roll back runtime state). Skipping the UPDATE when the
			// row already exists is the safest monotonic-merge rule.
			// Runtime messages not yet in the legacy log stay; legacy
			// messages missing from the runtime table get inserted by the
			// replay loop below.
			if (insertInfo.changes > 0) {
				this.stmtImportUpdateMetadata.run(
					log.topic ?? null,
					log.startedAt,
					log.lastMessageAt,
					log.lastReadAt ?? null,
					log.status,
					log.conversationId,
				);
			}

			// Replay messages. Each INSERT goes through the dedupe check so
			// retries after a crash are idempotent. Counting existing rows
			// once before the loop keeps `insert_order` monotonic across the
			// whole file.
			let insertOrder = (this.stmtCountMessages.get(log.conversationId) as { c: number }).c + 1;
			for (const message of sortedMessages) {
				if (typeof message.messageId === "string") {
					const dup = this.stmtFindDupMessage.get(
						log.conversationId,
						message.messageId,
						message.direction,
					);
					if (dup) continue;
				}
				this.stmtInsertMessage.run(
					log.conversationId,
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
				insertOrder += 1;
			}
		});

		importFn();
	}
}

/**
 * Shape validator for import. Rejects a log whose message array contains a
 * row that would fail at INSERT time. Running this before the transaction
 * opens keeps `importLog` all-or-nothing even for malformed input.
 */
function validateConversationLogForImport(log: ConversationLog): void {
	if (!Array.isArray(log.messages)) {
		throw new Error(`importLog: conversation ${log.conversationId} messages is not an array`);
	}
	const msgErr = (i: number, issue: string) =>
		new Error(`importLog: conversation ${log.conversationId} message[${i}] ${issue}`);
	for (let i = 0; i < log.messages.length; i += 1) {
		const message = log.messages[i];
		if (!message || typeof message !== "object") throw msgErr(i, "is not an object");
		if (typeof message.timestamp !== "string" || message.timestamp.length === 0)
			throw msgErr(i, "has missing or non-string timestamp");
		if (message.direction !== "incoming" && message.direction !== "outgoing")
			throw msgErr(i, `has invalid direction: ${String(message.direction)}`);
		if (typeof message.scope !== "string") throw msgErr(i, "has non-string scope");
		if (typeof message.content !== "string") throw msgErr(i, "has non-string content");
		if (typeof message.humanApprovalRequired !== "boolean")
			throw msgErr(i, "has non-boolean humanApprovalRequired");
		if (message.humanApprovalGiven !== null && typeof message.humanApprovalGiven !== "boolean")
			throw msgErr(i, "has invalid humanApprovalGiven");
		if (message.messageId !== undefined && typeof message.messageId !== "string")
			throw msgErr(i, "has non-string messageId");
	}
}

function rowToConversationLog(row: ConversationRow, messages: MessageRow[]): ConversationLog {
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
		humanApprovalGiven: row.human_approval_given === null ? null : row.human_approval_given === 1,
		...(row.human_approval_at ? { humanApprovalAt: row.human_approval_at } : {}),
	};
}
