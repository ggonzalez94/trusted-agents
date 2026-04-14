import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataDir } from "../common/index.js";
import type { SqliteConversationLogger } from "./sqlite-logger.js";
import type { ConversationLog } from "./types.js";

const CONVERSATIONS_DIRNAME = "conversations";
const BACKUP_DIRNAME = "conversations.bak";
const MIGRATION_FLAG_KEY = "conversation_logs_migrated_at";

export interface MigrationReport {
	migrated: number;
	skipped: number;
	errors: { file: string; error: string }[];
}

/**
 * Migrates legacy per-conversation JSON files into the SQLite conversation
 * store. Callers MUST inspect `report.errors` after this returns — partial
 * failure is the explicit contract:
 *
 * - If any file errored, the global migration flag is NOT set and the legacy
 *   `conversations/` directory is left in place. On the next call, the
 *   ``migrated_files`` table lets the loop skip already-imported files so it
 *   only retries the ones that failed.
 * - If every file succeeded, the flag is set and the legacy directory is
 *   renamed to a unique backup name so the next call is a no-op.
 *
 * This is fail-closed by design (finding Fv2.1): marking the migration
 * complete on partial failure would lose messages from any file that didn't
 * parse cleanly, and the caller would have no way to recover.
 *
 * Per-file tracking (residual 2): once a file has been successfully replayed
 * and had its canonical metadata restored, a row lands in ``migrated_files``
 * inside the same transaction as the metadata UPDATE. On a retry run, that
 * row makes the loop skip the file entirely so new runtime activity (e.g.
 * later messages arriving via tapd between the failed and successful
 * attempts) is never rolled back by a re-replay of the stale source JSON.
 *
 * After a fully-successful run the legacy directory is moved to
 * ``conversations.bak/`` and the global flag exits the migration early on
 * every subsequent startup — the ``migrated_files`` table remains, but is
 * harmless and never read again.
 */
export async function migrateFileLogsToSqlite(
	dataDir: string,
	logger: SqliteConversationLogger,
): Promise<MigrationReport> {
	const resolved = resolveDataDir(dataDir);
	const conversationsDir = join(resolved, CONVERSATIONS_DIRNAME);

	// Idempotency check: read the migration flag from schema_meta.
	const flag = logger.database
		.prepare("SELECT value FROM schema_meta WHERE key = ?")
		.get(MIGRATION_FLAG_KEY) as { value: string } | undefined;
	if (flag) {
		return { migrated: 0, skipped: 0, errors: [] };
	}

	let entries: string[];
	try {
		entries = await readdir(conversationsDir);
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			// No legacy data — mark as migrated and exit cleanly.
			markMigrationComplete(logger);
			return { migrated: 0, skipped: 0, errors: [] };
		}
		throw error;
	}

	const report: MigrationReport = { migrated: 0, skipped: 0, errors: [] };

	const selectMigratedFile = logger.database.prepare(
		"SELECT 1 FROM migrated_files WHERE file_name = ?",
	);
	const insertMigratedFile = logger.database.prepare(
		"INSERT OR REPLACE INTO migrated_files(file_name, migrated_at) VALUES (?, ?)",
	);
	const insertEmptyConversation = logger.database.prepare(
		`INSERT OR IGNORE INTO conversations(
			conversation_id, connection_id, peer_agent_id, peer_display_name,
			topic, started_at, last_message_at, last_read_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateCanonicalMetadata = logger.database.prepare(
		`UPDATE conversations
		 SET topic = ?, started_at = ?, last_message_at = ?, last_read_at = ?, status = ?
		 WHERE conversation_id = ?`,
	);

	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			report.skipped += 1;
			continue;
		}

		// Skip files that have already been imported on a prior run. The
		// row in migrated_files means replay + metadata UPDATE landed
		// atomically, so any runtime activity since then (new messages,
		// updated last_read_at) is canonical and must not be clobbered
		// by re-importing the stale JSON (residual 2).
		const already = selectMigratedFile.get(entry) as { 1: number } | undefined;
		if (already) {
			report.skipped += 1;
			continue;
		}

		const filePath = join(conversationsDir, entry);
		try {
			const raw = await readFile(filePath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (!isConversationLog(parsed)) {
				report.errors.push({ file: entry, error: "missing required fields" });
				continue;
			}
			const log = parsed;

			// The message replay path runs outside the transaction
			// because SqliteConversationLogger.logMessage is async and
			// better-sqlite3 transactions must be synchronous. We replay
			// first, then atomically UPDATE canonical metadata + INSERT
			// the migrated_files marker so a crash mid-metadata never
			// leaves the marker without the UPDATE (or vice versa).
			if (log.messages.length === 0) {
				// Insert the conversation row directly when there are no messages.
				// Done inside the same transaction as the marker below.
				// Stored for the transaction block.
			} else {
				// Each message gets logged through the normal logMessage path so dedupe,
				// insert_order, and timestamp normalization all apply. Sort by
				// timestamp ascending BEFORE replay — the legacy FileConversationLogger
				// sorted on read, so disk order is not guaranteed chronological
				// (finding Fv2.2). Replaying in source order would corrupt
				// `started_at`/`last_message_at` derived from the first/last append.
				const sortedMessages = [...log.messages].sort((a, b) =>
					a.timestamp.localeCompare(b.timestamp),
				);

				let firstMessage = true;
				for (const message of sortedMessages) {
					await logger.logMessage(
						log.conversationId,
						message,
						firstMessage
							? {
									connectionId: log.connectionId,
									peerAgentId: log.peerAgentId,
									peerDisplayName: log.peerDisplayName,
									...(log.topic ? { topic: log.topic } : {}),
								}
							: undefined,
					);
					firstMessage = false;
				}
			}

			// Atomic finalize: restore canonical metadata AND mark the
			// file as imported. Either both land or neither does, which
			// preserves the retry invariant — a crash between UPDATE and
			// migrated_files INSERT must not leave the file looking
			// imported while its metadata is only partially restored.
			const finalize = logger.database.transaction(() => {
				if (log.messages.length === 0) {
					insertEmptyConversation.run(
						log.conversationId,
						log.connectionId,
						log.peerAgentId,
						log.peerDisplayName,
						log.topic ?? null,
						log.startedAt,
						log.lastMessageAt,
						log.lastReadAt ?? null,
						log.status,
					);
				}

				// Restore canonical conversation metadata from the source JSON. The
				// insert/replay path derives started_at from the first row and
				// status is hard-coded to 'active' by the INSERT statement, so we
				// explicitly overwrite with the values that existed in the legacy
				// log (finding Fv2.2).
				updateCanonicalMetadata.run(
					log.topic ?? null,
					log.startedAt,
					log.lastMessageAt,
					log.lastReadAt ?? null,
					log.status,
					log.conversationId,
				);
				insertMigratedFile.run(entry, new Date().toISOString());
			});
			finalize();

			report.migrated += 1;
		} catch (error: unknown) {
			report.errors.push({
				file: entry,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Fail-closed: only mark complete and move the legacy directory when every
	// file was imported cleanly. Partial failures leave the legacy state in
	// place so the next run retries the bad files (finding Fv2.1).
	if (report.errors.length === 0) {
		try {
			await renameToUniqueBackup(conversationsDir, resolved);
		} catch (error: unknown) {
			report.errors.push({
				file: CONVERSATIONS_DIRNAME,
				error: `rename to backup failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			return report;
		}
		markMigrationComplete(logger);
	}

	return report;
}

function markMigrationComplete(logger: SqliteConversationLogger): void {
	logger.database
		.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)")
		.run(MIGRATION_FLAG_KEY, new Date().toISOString());
}

async function renameToUniqueBackup(source: string, parentDir: string): Promise<void> {
	let target = join(parentDir, BACKUP_DIRNAME);
	try {
		await rename(source, target);
		return;
	} catch (error: unknown) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			(error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
		) {
			// Fall through to suffix strategy for any rename failure except when the
			// source itself doesn't exist (ENOENT, already moved). Re-throw ENOENT.
			if (
				error instanceof Error &&
				"code" in error &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return;
			}
		}
	}
	let suffix = 1;
	while (suffix < 1000) {
		target = join(parentDir, `${BACKUP_DIRNAME}.${suffix}`);
		try {
			await rename(source, target);
			return;
		} catch (error: unknown) {
			if (
				error instanceof Error &&
				"code" in error &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return;
			}
			suffix += 1;
		}
	}
	throw new Error("unable to find unique backup destination for conversations directory");
}

function isConversationLog(value: unknown): value is ConversationLog {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.conversationId === "string" &&
		typeof v.connectionId === "string" &&
		typeof v.peerAgentId === "number" &&
		typeof v.peerDisplayName === "string" &&
		typeof v.startedAt === "string" &&
		typeof v.lastMessageAt === "string" &&
		typeof v.status === "string" &&
		Array.isArray(v.messages)
	);
}
