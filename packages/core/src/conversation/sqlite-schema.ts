import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id    TEXT PRIMARY KEY,
  connection_id      TEXT NOT NULL,
  peer_agent_id      INTEGER NOT NULL,
  peer_display_name  TEXT NOT NULL,
  topic              TEXT,
  started_at         TEXT NOT NULL,
  last_message_at    TEXT NOT NULL,
  last_read_at       TEXT,
  status             TEXT NOT NULL CHECK (status IN ('active','completed','archived'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_connection_id
  ON conversations(connection_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
  ON conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  conversation_id          TEXT NOT NULL,
  message_id               TEXT,
  timestamp                TEXT NOT NULL,
  direction                TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
  scope                    TEXT NOT NULL,
  content                  TEXT NOT NULL,
  human_approval_required  INTEGER NOT NULL,
  human_approval_given     INTEGER,
  human_approval_at        TEXT,
  insert_order             INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp
  ON messages(conversation_id, timestamp ASC, insert_order ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
  ON messages(conversation_id, message_id, direction)
  WHERE message_id IS NOT NULL;
`;

export function applySchema(db: Database.Database): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA synchronous = NORMAL");

	db.exec(SCHEMA_SQL);

	const meta = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
		| { value: string }
		| undefined;
	if (!meta) {
		db.prepare("INSERT INTO schema_meta(key, value) VALUES('version', ?)").run(
			String(CURRENT_SCHEMA_VERSION),
		);
	}
}

export function getSchemaVersion(db: Database.Database): number {
	const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
		| { value: string }
		| undefined;
	if (!row) return 0;
	const parsed = Number.parseInt(row.value, 10);
	return Number.isFinite(parsed) ? parsed : 0;
}
