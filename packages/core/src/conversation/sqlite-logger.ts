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
		// Canonicalize the runtime timestamp on the way in so the row we
		// INSERT (and any conversation row we create here) hits the
		// SQLite store in the canonical 24-char `YYYY-MM-DDTHH:mm:ss.sssZ`
		// form. This is the runtime half of the encoding invariant —
		// importLog handles the legacy half. With both write paths
		// canonicalizing, lexical `ORDER BY` clauses in
		// `stmtSelectMessages` and `stmtListAllConversations` produce
		// true temporal order without needing a parallel epoch column.
		if (typeof message.timestamp !== "string" || !isStrictIsoTimestamp(message.timestamp)) {
			throw new Error(
				`logMessage: message.timestamp must be a strict ISO 8601 timestamp with explicit offset, got: ${String(message.timestamp)}`,
			);
		}
		const canonicalTimestamp = canonicalizeTimestamp(message.timestamp);
		const canonicalApprovalAt =
			message.humanApprovalAt === undefined || message.humanApprovalAt === null
				? null
				: canonicalizeTimestamp(message.humanApprovalAt);

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
					canonicalTimestamp,
					canonicalTimestamp,
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
					canonicalTimestamp,
					context?.topic ?? null,
					conversationId,
				);
			}

			const count = this.stmtCountMessages.get(conversationId) as { c: number };
			const insertOrder = count.c + 1;

			this.stmtInsertMessage.run(
				conversationId,
				message.messageId ?? null,
				canonicalTimestamp,
				message.direction,
				message.scope,
				message.content,
				message.humanApprovalRequired ? 1 : 0,
				message.humanApprovalGiven === null ? null : message.humanApprovalGiven ? 1 : 0,
				canonicalApprovalAt,
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

		// Canonicalize every timestamp on the log before persistence.
		// `validateConversationLogForImport` has already enforced strict
		// ISO 8601 with explicit offset; canonicalization normalizes any
		// non-Z offset / sub-millisecond fraction / mixed precision into
		// the single 24-char `YYYY-MM-DDTHH:mm:ss.sssZ` form, so the
		// SQLite store only ever holds rows whose lexical order equals
		// their instant order. Once that invariant holds for every write
		// path (here and in `logMessage`), the lexical `ORDER BY` clauses
		// in `stmtSelectMessages` / `stmtListAllConversations` /
		// `stmtListConversationsByConnection` produce true temporal order
		// and we don't need a parallel epoch column.
		const canonicalStartedAt = canonicalizeTimestamp(log.startedAt);
		const canonicalLastMessageAt = canonicalizeTimestamp(log.lastMessageAt);
		const canonicalLastReadAt = canonicalizeOptionalTimestamp(log.lastReadAt ?? null);

		// Sort messages by their CANONICAL timestamp ascending. We can't
		// rely on the input order — legacy FileConversationLogger sorted
		// on read, so disk order is not chronological — and we can't sort
		// the raw timestamps lexically because mixed precision/offset
		// disagrees with instant order (the Codex residual that drove
		// this fix). Canonicalize first, then sort. The `canonical` field
		// is also what we INSERT below so dedupe + insert_order match.
		const sortedMessages = log.messages
			.map((message) => ({
				canonical: canonicalizeTimestamp(message.timestamp),
				message,
			}))
			.sort((a, b) => a.canonical.localeCompare(b.canonical));

		const importFn = this.db.transaction(() => {
			// INSERT OR IGNORE — returns `changes: 1` when a fresh row was
			// created and `changes: 0` when the row already existed.
			const insertInfo = this.stmtInsertConversation.run(
				log.conversationId,
				log.connectionId,
				log.peerAgentId,
				log.peerDisplayName,
				log.topic ?? null,
				canonicalStartedAt,
				canonicalLastMessageAt,
			);

			// Metadata strategy: monotonic field-level merge.
			//
			// On a fresh insert (changes > 0), apply the legacy log's
			// canonical metadata directly — it's the only source of truth.
			//
			// On an existing row (changes === 0), the row could have come
			// from one of two paths:
			//   (a) Pre-residual-2 partial import: the OLD migration code
			//       used logMessage() in a loop, so a failure mid-file
			//       could leave the row behind with placeholder metadata
			//       (started_at = first replayed message's timestamp,
			//       last_read_at = NULL, status = 'active'). On retry the
			//       legacy log holds the true canonical metadata and we
			//       MUST repair the placeholder, otherwise the partial
			//       state is permanent.
			//   (b) Runtime activity touched the conversation between a
			//       failed first-attempt and a successful retry of a
			//       fixed legacy file. The runtime row carries newer
			//       authoritative metadata that must NOT be rolled back
			//       to the legacy snapshot.
			//
			// A blanket "skip the UPDATE" suppresses (a). A blanket
			// "overwrite" rolls back (b). The safe rule is field-level
			// monotonic merge: each column resolves to the more-canonical
			// of the two values, where "more canonical" is well-defined
			// per field. See `mergeImportMetadata` below.
			if (insertInfo.changes > 0) {
				this.stmtImportUpdateMetadata.run(
					log.topic ?? null,
					canonicalStartedAt,
					canonicalLastMessageAt,
					canonicalLastReadAt,
					log.status,
					log.conversationId,
				);
			} else {
				const existing = this.stmtSelectConversation.get(log.conversationId) as
					| ConversationRow
					| undefined;
				if (existing) {
					// `existing` may carry pre-canonical timestamps from a
					// pre-fix install. The merge handles the comparison
					// correctly (instant-based) and writes out the chosen
					// VALUE, but we additionally canonicalize the chosen
					// value before writing so the row migrates to the new
					// invariant: every column on disk is canonical.
					const merged = mergeImportMetadata(existing, {
						...log,
						startedAt: canonicalStartedAt,
						lastMessageAt: canonicalLastMessageAt,
						...(canonicalLastReadAt !== null ? { lastReadAt: canonicalLastReadAt } : {}),
					});
					this.stmtImportUpdateMetadata.run(
						merged.topic,
						canonicalizeTimestampSafe(merged.startedAt),
						canonicalizeTimestampSafe(merged.lastMessageAt),
						merged.lastReadAt === null ? null : canonicalizeTimestampSafe(merged.lastReadAt),
						merged.status,
						log.conversationId,
					);
				}
			}

			// Replay messages. Each INSERT goes through the dedupe check so
			// retries after a crash are idempotent. Counting existing rows
			// once before the loop keeps `insert_order` monotonic across the
			// whole file. We INSERT the CANONICAL timestamp so the message
			// column matches the encoding invariant.
			let insertOrder = (this.stmtCountMessages.get(log.conversationId) as { c: number }).c + 1;
			for (const { canonical, message } of sortedMessages) {
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
					canonical,
					message.direction,
					message.scope,
					message.content,
					message.humanApprovalRequired ? 1 : 0,
					message.humanApprovalGiven === null ? null : message.humanApprovalGiven ? 1 : 0,
					message.humanApprovalAt === undefined
						? null
						: canonicalizeTimestampSafe(message.humanApprovalAt),
					insertOrder,
				);
				insertOrder += 1;
			}
		});

		importFn();
	}
}

interface MergedImportMetadata {
	topic: string | null;
	startedAt: string;
	lastMessageAt: string;
	lastReadAt: string | null;
	status: "active" | "completed" | "archived";
}

/**
 * Field-level monotonic merge of an existing conversation row with the
 * canonical metadata from a legacy log being imported. Each column resolves
 * to the more-canonical of the two values:
 *
 *   - **topic**: prefer existing if set (runtime owns it once written),
 *     else fall back to the legacy topic. Strict "any state wins over no
 *     state".
 *   - **startedAt**: MIN — the conversation actually started at the earlier
 *     of the two known starts. A conversation reactivated after a long
 *     pause should keep its earliest known start, not the row creation time.
 *   - **lastMessageAt**: MAX — only the latest known activity is canonical.
 *     Runtime writes always advance this; legacy can only fill it in when
 *     the existing row's value was a placeholder behind the legacy snapshot.
 *   - **lastReadAt**: MAX with NULL-as-`-infinity`. A non-NULL read marker
 *     is always more canonical than NULL.
 *   - **status**: monotonic order `active < completed < archived`. The more
 *     "progressed" status wins so runtime cannot un-archive nor un-complete
 *     a thread, but a legacy archive does override a placeholder `active`.
 *
 * This is the safe rule for both the pre-fix partial-import upgrade path
 * (legacy values repair placeholder runtime state) and the failed-then-runtime
 * eventual-success path (runtime values are not rolled back).
 */
function mergeImportMetadata(
	existing: ConversationRow,
	legacy: ConversationLog,
): MergedImportMetadata {
	return {
		topic: existing.topic ?? legacy.topic ?? null,
		startedAt: pickEarlierInstant(existing.started_at, legacy.startedAt),
		lastMessageAt: pickLaterInstant(existing.last_message_at, legacy.lastMessageAt),
		lastReadAt: mergeLastReadAt(existing.last_read_at, legacy.lastReadAt ?? null),
		status: mergeStatus(existing.status, legacy.status),
	};
}

/** Returns the timestamp with the earlier instant (MIN). */
function pickEarlierInstant(a: string, b: string): string {
	return compareTimestampInstants(a, b) <= 0 ? a : b;
}

/** Returns the timestamp with the later instant (MAX). */
function pickLaterInstant(a: string, b: string): string {
	return compareTimestampInstants(a, b) >= 0 ? a : b;
}

/**
 * Compare two ISO 8601 timestamps as instants (milliseconds since epoch).
 * Returns negative if `a` is earlier, positive if `a` is later, zero if
 * equal. Uses `Date.parse` so mixed precision (`...00Z` vs `...00.500Z`)
 * and mixed timezones (`+00:00` vs `Z`, or `Z` vs `-01:00`) compare
 * correctly. The migration validator rejects unparseable timestamps before
 * the merge runs, so a NaN result here can only come from a runtime row
 * we did not validate; in that case fall back to lexical order to remain
 * deterministic.
 */
function compareTimestampInstants(a: string, b: string): number {
	const aMs = Date.parse(a);
	const bMs = Date.parse(b);
	if (Number.isNaN(aMs) || Number.isNaN(bMs)) {
		if (a === b) return 0;
		return a < b ? -1 : 1;
	}
	return aMs - bMs;
}

function mergeLastReadAt(existing: string | null, legacy: string | null): string | null {
	if (existing === null) return legacy;
	if (legacy === null) return existing;
	return pickLaterInstant(existing, legacy);
}

const STATUS_RANK: Record<string, number> = { active: 0, completed: 1, archived: 2 };

function mergeStatus(
	existing: string,
	legacy: ConversationLog["status"],
): "active" | "completed" | "archived" {
	const existingRank = STATUS_RANK[existing] ?? 0;
	const legacyRank = STATUS_RANK[legacy] ?? 0;
	const winner = existingRank >= legacyRank ? existing : legacy;
	if (winner === "active" || winner === "completed" || winner === "archived") {
		return winner;
	}
	return "active";
}

/**
 * Shape validator for import. Rejects a log whose message array contains a
 * row that would fail at INSERT time. Running this before the transaction
 * opens keeps `importLog` all-or-nothing even for malformed input.
 *
 * Also rejects top-level timestamps (`startedAt`, `lastMessageAt`,
 * `lastReadAt`) and per-message timestamps that `Date.parse` cannot
 * interpret. This is a hard requirement for the merge step:
 * `mergeImportMetadata` compares timestamps as instants, so any value
 * that yields `NaN` from `Date.parse` would otherwise silently fall
 * through to a lexical fallback. Reject it upstream and force the
 * caller to surface the error per-file via the migration's error list.
 */
function validateConversationLogForImport(log: ConversationLog): void {
	if (!Array.isArray(log.messages)) {
		throw new Error(`importLog: conversation ${log.conversationId} messages is not an array`);
	}

	const topErr = (field: string, issue: string) =>
		new Error(`importLog: conversation ${log.conversationId} ${field} ${issue}`);
	if (typeof log.startedAt !== "string" || !isStrictIsoTimestamp(log.startedAt)) {
		throw topErr(
			"startedAt",
			"is not a strict ISO 8601 timestamp with explicit offset (Z or ±HH:MM)",
		);
	}
	if (typeof log.lastMessageAt !== "string" || !isStrictIsoTimestamp(log.lastMessageAt)) {
		throw topErr(
			"lastMessageAt",
			"is not a strict ISO 8601 timestamp with explicit offset (Z or ±HH:MM)",
		);
	}
	if (log.lastReadAt !== undefined && log.lastReadAt !== null) {
		if (typeof log.lastReadAt !== "string" || !isStrictIsoTimestamp(log.lastReadAt)) {
			throw topErr(
				"lastReadAt",
				"is not a strict ISO 8601 timestamp with explicit offset (Z or ±HH:MM)",
			);
		}
	}

	const msgErr = (i: number, issue: string) =>
		new Error(`importLog: conversation ${log.conversationId} message[${i}] ${issue}`);
	for (let i = 0; i < log.messages.length; i += 1) {
		const message = log.messages[i];
		if (!message || typeof message !== "object") throw msgErr(i, "is not an object");
		if (typeof message.timestamp !== "string" || message.timestamp.length === 0)
			throw msgErr(i, "has missing or non-string timestamp");
		if (!isStrictIsoTimestamp(message.timestamp))
			throw msgErr(
				i,
				`has non-canonical timestamp (must be strict ISO 8601 with explicit offset): ${message.timestamp}`,
			);
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

function isParseableInstant(value: string): boolean {
	if (value.length === 0) return false;
	return !Number.isNaN(Date.parse(value));
}

/**
 * Strict RFC 3339 / ISO 8601 timestamp regex with REQUIRED explicit offset.
 *
 * Form: `YYYY-MM-DDTHH:mm:ss[.fff]<Z|±HH:MM>`
 *
 * What this rejects on purpose:
 *
 *   - Missing offset (`2026-04-10T12:00:00`). `Date.parse` interprets this
 *     as local time, which is host-dependent and silently shifts the
 *     instant. Always requiring `Z` or `±HH:MM` makes the encoding
 *     unambiguous.
 *   - RFC 2822 strings (`Mon, 10 Apr 2026 12:00:00 GMT`). They parse but
 *     are not the canonical encoding we use anywhere else.
 *   - Date-only strings (`2026-04-10`). Same reason as above.
 *
 * What this accepts:
 *
 *   - `2026-04-10T12:00:00Z`
 *   - `2026-04-10T12:00:00.500Z`
 *   - `2026-04-10T12:00:00.123456Z` (sub-millisecond fractions allowed —
 *     `canonicalizeTimestamp` truncates them when normalizing because
 *     JavaScript Date only carries millisecond precision; rejecting them
 *     would force every legacy log to be rewritten before import)
 *   - `2026-04-10T13:00:00+01:00`
 *   - `2026-04-10T11:00:00-01:00`
 *
 * Both the import validator and the runtime log writer enforce this
 * format so the SQLite store only ever holds canonical, lexically-sortable
 * timestamps. Once everything in the DB is canonical, the lexical
 * `ORDER BY timestamp ASC` clauses match the true temporal order and we
 * never have to keep a parallel epoch column.
 */
const STRICT_ISO_OFFSET_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isStrictIsoTimestamp(value: string): boolean {
	if (!STRICT_ISO_OFFSET_REGEX.test(value)) return false;
	return !Number.isNaN(Date.parse(value));
}

/**
 * Normalize a strict-ISO timestamp to its canonical UTC representation:
 * `YYYY-MM-DDTHH:mm:ss.sssZ` (24 chars, milliseconds, Z offset). Throws
 * if the input does not match the strict format.
 *
 * Why canonicalize: SQLite stores timestamps as TEXT and `ORDER BY` is
 * lexical. Once every row is in this canonical 24-char form, lexical
 * order and instant order are guaranteed to agree. Sub-millisecond
 * precision in the input is truncated because JavaScript Date carries
 * only millisecond precision; this is acknowledged and consistent with
 * the rest of the codebase.
 */
export function canonicalizeTimestamp(value: string): string {
	if (typeof value !== "string" || !isStrictIsoTimestamp(value)) {
		throw new Error(
			`canonicalizeTimestamp: not a strict ISO 8601 timestamp with explicit offset: ${String(value)}`,
		);
	}
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) {
		throw new Error(`canonicalizeTimestamp: Date.parse failed for: ${value}`);
	}
	return new Date(ms).toISOString();
}

/** Same as `canonicalizeTimestamp` but tolerates `null`/`undefined`. */
function canonicalizeOptionalTimestamp(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return canonicalizeTimestamp(value);
}

/**
 * Canonicalize a timestamp that may have come from an existing SQLite row
 * (i.e. it could already be canonical, or it could be a pre-canonical
 * legacy value). Falls back to returning the input unchanged if it is not
 * a strict ISO timestamp — that path only fires for pre-fix runtime rows
 * that the merge loop is already handling instant-correctly.
 *
 * The migration's intent is to upgrade existing rows to the canonical
 * encoding incrementally: any row touched by an import gets canonicalized
 * on the way out, but a row we cannot canonicalize is left as-is rather
 * than dropping its data.
 */
function canonicalizeTimestampSafe(value: string): string {
	if (isStrictIsoTimestamp(value)) return canonicalizeTimestamp(value);
	return value;
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
