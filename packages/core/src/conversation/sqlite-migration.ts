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
 * - If any file errored, the migration flag is NOT set, the legacy
 *   `conversations/` directory is left in place, and a subsequent call will
 *   retry every file (including the already-imported ones, which are
 *   idempotent at the SQLite level via the message dedup index).
 * - If every file succeeded, the flag is set and the legacy directory is
 *   renamed to a unique backup name so the next call is a no-op.
 *
 * This is fail-closed by design (finding Fv2.1): marking the migration
 * complete on partial failure would lose messages from any file that didn't
 * parse cleanly, and the caller would have no way to recover.
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

	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
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

			if (log.messages.length === 0) {
				// Insert the conversation row directly when there are no messages.
				logger.database
					.prepare(
						`INSERT OR IGNORE INTO conversations(
							conversation_id, connection_id, peer_agent_id, peer_display_name,
							topic, started_at, last_message_at, last_read_at, status
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
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
			} else {
				// Each message gets logged through the normal logMessage path so dedupe,
				// insert_order, and timestamp normalization all apply.
				let firstMessage = true;
				for (const message of log.messages) {
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
				if (log.lastReadAt) {
					await logger.markRead(log.conversationId, log.lastReadAt);
				}
			}
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
