# tapd v2: SQLite Conversation Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or run inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-conversation JSON file storage in `FileConversationLogger` with a single SQLite database at `<dataDir>/conversations.db`. Provide a one-time, idempotent migration that imports existing JSON files. After v2, all conversation reads and writes go through SQLite, the JSON files are archived as `<dataDir>/conversations.bak/`, and the new store is the single source of truth.

**Architecture:** A new `SqliteConversationLogger` class implements the existing `IConversationLogger` interface. The class owns a `better-sqlite3` connection in WAL mode, with a normalized two-table schema (`conversations` + `messages`), proper indices, and transaction-safe writes. The migration helper reads `<dataDir>/conversations/*.json`, inserts into SQLite inside a single transaction, and on success moves the JSON dir to `<dataDir>/conversations.bak/` so the original data survives on disk for at least one release. Because every existing caller already takes `IConversationLogger` (not `FileConversationLogger`), the swap is a one-line change in `default-context.ts` and a few CLI commands.

**Tech stack:** `better-sqlite3` (synchronous, native, battle-tested) added to `packages/core` as a new dependency. No other new dependencies. SQLite WAL mode for safe concurrent reads. Prepared statements for hot paths. Migration is a JS-level loop, not a SQL `.import`.

**Why now:** The conversation store is the largest piece of dead-weight in `<dataDir>` — it's a directory of N small JSON files that grows unbounded, has no indices, and triggers full-file rewrites on every message append. SQLite gives us:
- Single-file backup
- Indexed queries (by conversation, by connectionId, by lastMessageAt)
- Cheap appends (no full-file rewrite)
- Full-text search on message content, eventually
- Foundation for the next two v2 things (event log unification, channel primitive) — both of which need an indexed query layer

**Out of scope for this plan:**
- The journal (`request-journal.json`) — separate plan, similar shape, after this lands
- Event log unification (events still live in tapd's in-memory ring buffer)
- The channel primitive (still 1:1 connection-keyed)
- Full-text search on message content (FTS5 can be a follow-up)
- Multi-database support (one .db per identity stays)

---

## File map

**New files in `packages/core/`:**

```
packages/core/src/conversation/
  sqlite-logger.ts             # SqliteConversationLogger implementing IConversationLogger
  sqlite-schema.ts             # Schema definition + migration runner
  sqlite-migration.ts          # File → SQLite import helper
packages/core/test/unit/conversation/
  sqlite-logger.test.ts        # Behavior tests against a temp DB
  sqlite-migration.test.ts     # File-to-SQLite import tests
  sqlite-schema.test.ts        # Schema migration tests
```

**Modified in `packages/core/`:**

```
packages/core/package.json     # add better-sqlite3 dependency
packages/core/src/conversation/logger.ts  # FileConversationLogger stays as a fallback class but is no longer the default
packages/core/src/conversation/index.ts   # export SqliteConversationLogger and migration helper
packages/core/src/runtime/default-context.ts  # use SqliteConversationLogger; run migration on first start
```

**Modified in `packages/cli/`:**

```
packages/cli/src/lib/context.ts                    # use SqliteConversationLogger
packages/cli/src/commands/conversations-list.ts    # use SqliteConversationLogger
packages/cli/src/commands/conversations-show.ts    # use SqliteConversationLogger
```

**Modified in `packages/tapd/`:**

```
packages/tapd/src/bin.ts       # default-context wiring already covers tapd; no changes expected. Verify.
```

**Modified test files:**

```
packages/core/test/unit/conversation/file-logger.test.ts (or wherever)  # keep passing for FileConversationLogger
plus any test that constructs FileConversationLogger directly — switch to SqliteConversationLogger or leave alone if testing the file path explicitly
```

---

## Pre-flight: read these files

Before starting, the implementer should read in order:

1. `packages/core/src/conversation/logger.ts` — current `FileConversationLogger` and the `IConversationLogger` interface. Your new class implements the same interface.
2. `packages/core/src/conversation/types.ts` — `ConversationLog` and `ConversationMessage` shapes. The schema mirrors these.
3. `packages/core/src/conversation/transcript.ts` — `generateMarkdownTranscript` consumes `ConversationLog`. Your new logger returns the same shape, so this stays unchanged.
4. `packages/core/src/runtime/default-context.ts` — the wiring point.
5. `packages/cli/src/commands/conversations-list.ts` and `conversations-show.ts` — the CLI consumers.
6. `packages/tapd/src/http/routes/conversations.ts` — the HTTP route consumer.
7. `packages/cli/src/lib/context.ts` — the CLI's runtime wiring.
8. The output of `find <any test data dir>/conversations -name "*.json" | head` (if any local data exists) — sample of what you're migrating from.

---

## Schema design

Two tables, normalized. Indices on the columns we actually query.

```sql
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

CREATE INDEX IF NOT EXISTS idx_conversations_connection_id ON conversations(connection_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at DESC);

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

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- schema_meta seeded with: ('version', '1')
```

**Notes on the schema:**

- `human_approval_required` and `human_approval_given` are stored as 0/1/NULL because SQLite has no native boolean type.
- `insert_order` is a per-conversation integer that breaks ties when two messages share a timestamp. Set it to the row count at insertion time so the natural ordering preserves the order messages were appended in.
- The unique index on `(conversation_id, message_id, direction) WHERE message_id IS NOT NULL` enforces the same dedupe semantics the existing `FileConversationLogger.logMessage` uses (a message is a duplicate if its `messageId + direction` already exists in the same conversation).
- `ON DELETE CASCADE` on the foreign key keeps the messages table clean if a conversation is ever deleted.
- `schema_meta` future-proofs against schema upgrades. The migration runner reads/writes `version`.

---

## Task 1: Add `better-sqlite3` to `packages/core`

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Add the dependency**

Edit `packages/core/package.json` to add:

```json
"dependencies": {
  ...existing...,
  "better-sqlite3": "^11.5.0"
},
"devDependencies": {
  ...existing...,
  "@types/better-sqlite3": "^7.6.11"
}
```

- [ ] **Step 2: Install**

Run: `bun install`

Expected: better-sqlite3 native module installed under `packages/core/node_modules/better-sqlite3` with prebuilt binaries for the host platform.

**Note:** if better-sqlite3 fails to build (e.g., missing python or build tools), the implementer should diagnose and fix. On macOS this should be a non-issue with prebuilt binaries.

- [ ] **Step 3: Smoke test the import**

Create a tiny throwaway file `packages/core/scratch-sqlite.ts` (do NOT commit):

```ts
import Database from "better-sqlite3";
const db = new Database(":memory:");
db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");
console.log("better-sqlite3 ok");
db.close();
```

Run: `bun run --cwd packages/core exec node --experimental-strip-types scratch-sqlite.ts` (or `bunx tsx scratch-sqlite.ts`)

If it prints "better-sqlite3 ok", the dependency is wired. Delete the scratch file.

- [ ] **Step 4: Verify build still works**

Run: `bun run --cwd packages/core build && bun run --cwd packages/core typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json bun.lock
git commit -m "feat(core): add better-sqlite3 dependency"
```

---

## Task 2: SQLite schema runner

**Files:**
- Create: `packages/core/src/conversation/sqlite-schema.ts`
- Create: `packages/core/test/unit/conversation/sqlite-schema.test.ts`

A small module that exposes `applySchema(db)` and `getSchemaVersion(db)`. Idempotent: calling it on a fresh DB creates the tables, calling it on an already-migrated DB is a no-op.

- [ ] **Step 1: Write the failing test**

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, applySchema, getSchemaVersion } from "../../../src/conversation/sqlite-schema.js";

describe("sqlite-schema", () => {
  it("creates the conversation and messages tables", () => {
    const db = new Database(":memory:");
    applySchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["conversations", "messages", "schema_meta"]),
    );
    db.close();
  });

  it("seeds the schema version", () => {
    const db = new Database(":memory:");
    applySchema(db);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent", () => {
    const db = new Database(":memory:");
    applySchema(db);
    applySchema(db);
    applySchema(db);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("creates the dedupe index", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const indices = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'")
      .all() as { name: string }[];
    expect(indices.map((i) => i.name)).toEqual(
      expect.arrayContaining(["idx_messages_conversation_timestamp", "idx_messages_dedup"]),
    );
    db.close();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/core test test/unit/conversation/sqlite-schema.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement**

Create `packages/core/src/conversation/sqlite-schema.ts`:

```ts
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

  const meta = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined;
  if (!meta) {
    db.prepare("INSERT INTO schema_meta(key, value) VALUES('version', ?)").run(
      String(CURRENT_SCHEMA_VERSION),
    );
  }
}

export function getSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined;
  if (!row) return 0;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `bun run --cwd packages/core test test/unit/conversation/sqlite-schema.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conversation/sqlite-schema.ts packages/core/test/unit/conversation/sqlite-schema.test.ts
git commit -m "feat(core): add sqlite schema runner for conversation store"
```

---

## Task 3: SqliteConversationLogger implementation

**Files:**
- Create: `packages/core/src/conversation/sqlite-logger.ts`
- Create: `packages/core/test/unit/conversation/sqlite-logger.test.ts`
- Modify: `packages/core/src/conversation/index.ts` (export the new class)

Implements `IConversationLogger` against a real SQLite DB. Test against a temp directory using `mkdtemp`.

- [ ] **Step 1: Write the failing tests**

The test file should mirror the existing `file-logger` tests. Cover:

- `logMessage` creates a new conversation when none exists (requires context)
- `logMessage` appends to an existing conversation
- `logMessage` is dedupe-safe via `(messageId, direction)`
- `logMessage` updates `lastMessageAt` and `topic` if context provides it
- `getConversation` returns the full conversation with messages in order
- `listConversations` returns all conversations
- `listConversations` filters by `connectionId`
- `generateTranscript` returns markdown matching `generateMarkdownTranscript`
- `markRead` updates `lastReadAt`
- `markRead` is a no-op for unknown conversation IDs

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteConversationLogger } from "../../../src/conversation/sqlite-logger.js";

describe("SqliteConversationLogger", () => {
  let dataDir: string;
  let logger: SqliteConversationLogger;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "sqlite-conv-test-"));
    logger = new SqliteConversationLogger(dataDir);
  });

  afterEach(async () => {
    logger.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("creates a new conversation on first message", async () => {
    await logger.logMessage(
      "conv-1",
      {
        timestamp: "2026-04-01T00:00:00.000Z",
        direction: "outgoing",
        scope: "default",
        content: "hello",
        humanApprovalRequired: false,
        humanApprovalGiven: null,
      },
      {
        connectionId: "conn-1",
        peerAgentId: 42,
        peerDisplayName: "Alice",
      },
    );

    const log = await logger.getConversation("conv-1");
    expect(log?.messages).toHaveLength(1);
    expect(log?.peerDisplayName).toBe("Alice");
  });

  it("appends to an existing conversation", async () => {
    await logger.logMessage(
      "conv-1",
      makeMessage("2026-04-01T00:00:00.000Z", "first"),
      { connectionId: "conn-1", peerAgentId: 42, peerDisplayName: "Alice" },
    );
    await logger.logMessage(
      "conv-1",
      makeMessage("2026-04-01T00:01:00.000Z", "second"),
    );

    const log = await logger.getConversation("conv-1");
    expect(log?.messages.map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("dedupes by messageId+direction", async () => {
    const ctx = { connectionId: "conn-1", peerAgentId: 42, peerDisplayName: "Alice" };
    await logger.logMessage("conv-1", { ...makeMessage("2026-04-01T00:00:00.000Z", "first"), messageId: "m1" }, ctx);
    await logger.logMessage("conv-1", { ...makeMessage("2026-04-01T00:00:00.000Z", "first"), messageId: "m1" });
    await logger.logMessage("conv-1", { ...makeMessage("2026-04-01T00:00:00.000Z", "first"), messageId: "m1" });

    const log = await logger.getConversation("conv-1");
    expect(log?.messages).toHaveLength(1);
  });

  it("listConversations sorts by lastMessageAt", async () => {
    await logger.logMessage("conv-a", makeMessage("2026-04-01T00:00:00.000Z", "x"), {
      connectionId: "ca",
      peerAgentId: 1,
      peerDisplayName: "A",
    });
    await logger.logMessage("conv-b", makeMessage("2026-04-03T00:00:00.000Z", "x"), {
      connectionId: "cb",
      peerAgentId: 2,
      peerDisplayName: "B",
    });
    await logger.logMessage("conv-c", makeMessage("2026-04-02T00:00:00.000Z", "x"), {
      connectionId: "cc",
      peerAgentId: 3,
      peerDisplayName: "C",
    });

    const all = await logger.listConversations();
    expect(all.map((c) => c.conversationId)).toEqual(["conv-b", "conv-c", "conv-a"]);
  });

  it("listConversations filters by connectionId", async () => {
    await logger.logMessage("conv-a", makeMessage("2026-04-01T00:00:00.000Z", "x"), {
      connectionId: "ca",
      peerAgentId: 1,
      peerDisplayName: "A",
    });
    await logger.logMessage("conv-b", makeMessage("2026-04-02T00:00:00.000Z", "x"), {
      connectionId: "cb",
      peerAgentId: 2,
      peerDisplayName: "B",
    });

    const filtered = await logger.listConversations({ connectionId: "cb" });
    expect(filtered.map((c) => c.conversationId)).toEqual(["conv-b"]);
  });

  it("markRead updates lastReadAt", async () => {
    await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "x"), {
      connectionId: "conn-1",
      peerAgentId: 42,
      peerDisplayName: "Alice",
    });

    await logger.markRead("conv-1", "2026-04-01T00:01:00.000Z");
    const log = await logger.getConversation("conv-1");
    expect(log?.lastReadAt).toBe("2026-04-01T00:01:00.000Z");
  });

  it("markRead is a no-op for unknown conversations", async () => {
    await logger.markRead("nope", "2026-04-01T00:00:00.000Z");
    expect(await logger.getConversation("nope")).toBeNull();
  });

  it("generateTranscript returns markdown for an existing conversation", async () => {
    await logger.logMessage("conv-1", makeMessage("2026-04-01T00:00:00.000Z", "hello"), {
      connectionId: "conn-1",
      peerAgentId: 42,
      peerDisplayName: "Alice",
    });
    const md = await logger.generateTranscript("conv-1");
    expect(md).toContain("hello");
  });

  it("generateTranscript returns empty string for unknown conversations", async () => {
    expect(await logger.generateTranscript("nope")).toBe("");
  });
});

function makeMessage(timestamp: string, content: string) {
  return {
    timestamp,
    direction: "outgoing" as const,
    scope: "default",
    content,
    humanApprovalRequired: false,
    humanApprovalGiven: null,
  };
}
```

- [ ] **Step 2: Run, expect failure**

Run: `bun run --cwd packages/core test test/unit/conversation/sqlite-logger.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement**

Create `packages/core/src/conversation/sqlite-logger.ts`:

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { resolveDataDir } from "../common/index.js";
import { applySchema } from "./sqlite-schema.js";
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

  constructor(dataDir: string) {
    this.dataDir = resolveDataDir(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(this.dataDir, "conversations.db"));
    applySchema(this.db);
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
      const existing = this.db
        .prepare<[string]>("SELECT * FROM conversations WHERE conversation_id = ?")
        .get(conversationId) as ConversationRow | undefined;

      if (!existing) {
        if (!context) {
          throw new Error(
            "context is required when creating a new conversation log entry",
          );
        }
        this.db
          .prepare(
            `INSERT INTO conversations(
              conversation_id, connection_id, peer_agent_id, peer_display_name,
              topic, started_at, last_message_at, last_read_at, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active')`,
          )
          .run(
            conversationId,
            context.connectionId,
            context.peerAgentId,
            context.peerDisplayName,
            context.topic ?? null,
            message.timestamp,
            message.timestamp,
          );
      } else {
        // Dedupe via the unique index — if the message already exists for this
        // conversation_id + message_id + direction, the INSERT below throws.
        // We catch by checking the count first to keep the error message clean.
        if (typeof message.messageId === "string") {
          const dup = this.db
            .prepare<[string, string, string]>(
              `SELECT 1 FROM messages
               WHERE conversation_id = ? AND message_id = ? AND direction = ?
               LIMIT 1`,
            )
            .get(conversationId, message.messageId, message.direction) as
            | { 1: number }
            | undefined;
          if (dup) return;
        }

        this.db
          .prepare<[string, string, string]>(
            `UPDATE conversations
             SET last_message_at = ?, topic = COALESCE(?, topic)
             WHERE conversation_id = ?`,
          )
          .run(message.timestamp, context?.topic ?? null, conversationId);
      }

      const insertOrder =
        ((this.db
          .prepare<[string]>(
            "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?",
          )
          .get(conversationId) as { c: number }).c) + 1;

      this.db
        .prepare(
          `INSERT INTO messages(
            conversation_id, message_id, timestamp, direction, scope, content,
            human_approval_required, human_approval_given, human_approval_at, insert_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
    const row = this.db
      .prepare<[string]>("SELECT * FROM conversations WHERE conversation_id = ?")
      .get(conversationId) as ConversationRow | undefined;
    if (!row) return null;

    const messageRows = this.db
      .prepare<[string]>(
        `SELECT message_id, timestamp, direction, scope, content,
                human_approval_required, human_approval_given, human_approval_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY timestamp ASC, insert_order ASC`,
      )
      .all(conversationId) as MessageRow[];

    return rowToConversationLog(row, messageRows);
  }

  async listConversations(filter?: { connectionId?: string }): Promise<ConversationLog[]> {
    const rows = filter?.connectionId
      ? (this.db
          .prepare<[string]>(
            `SELECT * FROM conversations
             WHERE connection_id = ?
             ORDER BY last_message_at DESC`,
          )
          .all(filter.connectionId) as ConversationRow[])
      : (this.db
          .prepare(
            `SELECT * FROM conversations
             ORDER BY last_message_at DESC`,
          )
          .all() as ConversationRow[]);

    const result: ConversationLog[] = [];
    for (const row of rows) {
      const messages = this.db
        .prepare<[string]>(
          `SELECT message_id, timestamp, direction, scope, content,
                  human_approval_required, human_approval_given, human_approval_at
           FROM messages
           WHERE conversation_id = ?
           ORDER BY timestamp ASC, insert_order ASC`,
        )
        .all(row.conversation_id) as MessageRow[];
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
    this.db
      .prepare<[string, string]>(
        "UPDATE conversations SET last_read_at = ? WHERE conversation_id = ?",
      )
      .run(readAt, conversationId);
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
```

**Important:** the existing `IConversationLogger` interface lives in `packages/core/src/conversation/logger.ts`. Decide:

- **Option A:** Re-export the interface from `sqlite-logger.ts` (cleaner ownership)
- **Option B:** Keep the interface in `logger.ts` and import it (less churn)

Pick Option B. Don't move the interface.

- [ ] **Step 4: Run tests, expect pass**

Run: `bun run --cwd packages/core test test/unit/conversation/sqlite-logger.test.ts`
Expected: all 9 tests PASS.

- [ ] **Step 5: Update `packages/core/src/conversation/index.ts`**

Add `export { SqliteConversationLogger } from "./sqlite-logger.js";`

- [ ] **Step 6: Run typecheck and full core tests**

Run: `bun run --cwd packages/core typecheck && bun run --cwd packages/core test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/conversation/sqlite-logger.ts packages/core/test/unit/conversation/sqlite-logger.test.ts packages/core/src/conversation/index.ts
git commit -m "feat(core): add SqliteConversationLogger implementing IConversationLogger"
```

---

## Task 4: File-to-SQLite migration helper

**Files:**
- Create: `packages/core/src/conversation/sqlite-migration.ts`
- Create: `packages/core/test/unit/conversation/sqlite-migration.test.ts`

A function `migrateFileLogsToSqlite(dataDir, opts?)` that:
1. Reads every `<dataDir>/conversations/*.json` file
2. Parses each into a `ConversationLog`
3. Inserts the conversation + all messages into the SQLite DB inside one transaction
4. On success, renames `<dataDir>/conversations/` to `<dataDir>/conversations.bak/` (preserving the data on disk for recovery)
5. Records "migration_complete: true" in `schema_meta` so re-runs are no-ops
6. Returns a report `{ migrated, skipped, errors }`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteConversationLogger } from "../../../src/conversation/sqlite-logger.js";
import { migrateFileLogsToSqlite } from "../../../src/conversation/sqlite-migration.js";

describe("sqlite migration", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "sqlite-mig-test-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("imports an existing conversation JSON file", async () => {
    await mkdir(join(dataDir, "conversations"), { recursive: true });
    await writeFile(
      join(dataDir, "conversations", "conv-1.json"),
      JSON.stringify({
        conversationId: "conv-1",
        connectionId: "conn-1",
        peerAgentId: 42,
        peerDisplayName: "Alice",
        startedAt: "2026-04-01T00:00:00.000Z",
        lastMessageAt: "2026-04-01T00:01:00.000Z",
        status: "active",
        messages: [
          {
            messageId: "m1",
            timestamp: "2026-04-01T00:00:00.000Z",
            direction: "outgoing",
            scope: "default",
            content: "first",
            humanApprovalRequired: false,
            humanApprovalGiven: null,
          },
          {
            messageId: "m2",
            timestamp: "2026-04-01T00:01:00.000Z",
            direction: "incoming",
            scope: "default",
            content: "second",
            humanApprovalRequired: false,
            humanApprovalGiven: null,
          },
        ],
      }),
    );

    const logger = new SqliteConversationLogger(dataDir);
    const report = await migrateFileLogsToSqlite(dataDir, logger);
    expect(report.migrated).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.errors).toEqual([]);

    const log = await logger.getConversation("conv-1");
    expect(log?.messages).toHaveLength(2);
    expect(log?.peerDisplayName).toBe("Alice");
    logger.close();
  });

  it("moves the conversations directory to conversations.bak after success", async () => {
    await mkdir(join(dataDir, "conversations"), { recursive: true });
    await writeFile(
      join(dataDir, "conversations", "conv-1.json"),
      JSON.stringify({
        conversationId: "conv-1",
        connectionId: "conn-1",
        peerAgentId: 42,
        peerDisplayName: "Alice",
        startedAt: "2026-04-01T00:00:00.000Z",
        lastMessageAt: "2026-04-01T00:00:00.000Z",
        status: "active",
        messages: [
          {
            messageId: "m1",
            timestamp: "2026-04-01T00:00:00.000Z",
            direction: "outgoing",
            scope: "default",
            content: "x",
            humanApprovalRequired: false,
            humanApprovalGiven: null,
          },
        ],
      }),
    );

    const logger = new SqliteConversationLogger(dataDir);
    await migrateFileLogsToSqlite(dataDir, logger);

    const entries = (await readdir(dataDir)).filter((e) => e.startsWith("conversations"));
    expect(entries).toContain("conversations.bak");
    expect(entries).not.toContain("conversations");
    logger.close();
  });

  it("is a no-op on second run", async () => {
    await mkdir(join(dataDir, "conversations"), { recursive: true });
    await writeFile(
      join(dataDir, "conversations", "conv-1.json"),
      JSON.stringify({
        conversationId: "conv-1",
        connectionId: "conn-1",
        peerAgentId: 1,
        peerDisplayName: "A",
        startedAt: "x",
        lastMessageAt: "x",
        status: "active",
        messages: [],
      }),
    );

    const logger = new SqliteConversationLogger(dataDir);
    await migrateFileLogsToSqlite(dataDir, logger);
    const second = await migrateFileLogsToSqlite(dataDir, logger);
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(0);
    logger.close();
  });

  it("does nothing when no conversations directory exists", async () => {
    const logger = new SqliteConversationLogger(dataDir);
    const report = await migrateFileLogsToSqlite(dataDir, logger);
    expect(report.migrated).toBe(0);
    expect(report.errors).toEqual([]);
    logger.close();
  });

  it("collects errors for invalid files but continues", async () => {
    await mkdir(join(dataDir, "conversations"), { recursive: true });
    await writeFile(join(dataDir, "conversations", "valid.json"),
      JSON.stringify({
        conversationId: "valid",
        connectionId: "c",
        peerAgentId: 1,
        peerDisplayName: "A",
        startedAt: "2026-04-01T00:00:00.000Z",
        lastMessageAt: "2026-04-01T00:00:00.000Z",
        status: "active",
        messages: [
          {
            timestamp: "2026-04-01T00:00:00.000Z",
            direction: "outgoing",
            scope: "default",
            content: "x",
            humanApprovalRequired: false,
            humanApprovalGiven: null,
          },
        ],
      }),
    );
    await writeFile(join(dataDir, "conversations", "broken.json"), "{not json");

    const logger = new SqliteConversationLogger(dataDir);
    const report = await migrateFileLogsToSqlite(dataDir, logger);
    expect(report.migrated).toBe(1);
    expect(report.errors.length).toBeGreaterThanOrEqual(1);
    logger.close();
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

Create `packages/core/src/conversation/sqlite-migration.ts`:

```ts
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
      logger.database
        .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)")
        .run(MIGRATION_FLAG_KEY, new Date().toISOString());
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
      const log = JSON.parse(raw) as ConversationLog;
      if (!isConversationLog(log)) {
        report.errors.push({ file: entry, error: "missing required fields" });
        continue;
      }
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
      // For empty conversations, ensure the conversations row exists by
      // inserting a placeholder, then removing it via direct SQL. Cleaner
      // approach: insert the conversation row directly when messages.length === 0.
      if (log.messages.length === 0) {
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
      } else if (log.lastReadAt) {
        await logger.markRead(log.conversationId, log.lastReadAt);
      }
      report.migrated += 1;
    } catch (error: unknown) {
      report.errors.push({
        file: entry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Move the directory to a backup name so the data survives but the legacy
  // path is no longer present (subsequent FileConversationLogger constructions
  // see no files).
  try {
    await rename(conversationsDir, join(resolved, BACKUP_DIRNAME));
  } catch (error: unknown) {
    report.errors.push({
      file: CONVERSATIONS_DIRNAME,
      error: `rename to backup failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Mark migration complete only if no irrecoverable errors occurred.
  // Errors per-file are recorded but don't block the flag — we don't want to
  // re-import the same files on the next run.
  logger.database
    .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)")
    .run(MIGRATION_FLAG_KEY, new Date().toISOString());

  return report;
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
```

- [ ] **Step 4: Run tests, expect pass**

Run: `bun run --cwd packages/core test test/unit/conversation/sqlite-migration.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Export the helper**

Update `packages/core/src/conversation/index.ts` to add:

```ts
export { migrateFileLogsToSqlite, type MigrationReport } from "./sqlite-migration.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/conversation/sqlite-migration.ts packages/core/test/unit/conversation/sqlite-migration.test.ts packages/core/src/conversation/index.ts
git commit -m "feat(core): add file-to-sqlite conversation log migration"
```

---

## Task 5: Wire SqliteConversationLogger into `default-context.ts`

**Files:**
- Modify: `packages/core/src/runtime/default-context.ts`

`buildDefaultTapRuntimeContext` currently constructs `FileConversationLogger`. Switch it to `SqliteConversationLogger` and run the migration once.

The migration runs **synchronously during context build** (it's idempotent — subsequent runs are cheap), inside a try/catch that logs but doesn't fail the context build.

```ts
// In buildDefaultTapRuntimeContext, replace:
const conversationLogger =
  options.conversationLogger ?? new FileConversationLogger(config.dataDir);

// With:
let conversationLogger: IConversationLogger;
if (options.conversationLogger) {
  conversationLogger = options.conversationLogger;
} else {
  const sqliteLogger = new SqliteConversationLogger(config.dataDir);
  try {
    await migrateFileLogsToSqlite(config.dataDir, sqliteLogger);
  } catch (error: unknown) {
    // Migration failure is non-fatal — the database is still usable.
    // Log via console (default-context has no logger reference).
    process.stderr.write(
      `[trusted-agents] conversation log migration warning: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  conversationLogger = sqliteLogger;
}
```

Add the imports:

```ts
import { SqliteConversationLogger, migrateFileLogsToSqlite } from "../conversation/index.js";
```

Remove the now-unused `FileConversationLogger` import if it's only used for the default path.

- [ ] **Step 1: Apply the change**
- [ ] **Step 2: Run `bun run --cwd packages/core typecheck`**
- [ ] **Step 3: Run `bun run --cwd packages/core test`** — note: many existing service tests may construct contexts. Verify they still pass with the new default logger.
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(core): default-context uses SqliteConversationLogger and migrates on first build"
```

---

## Task 6: Update CLI conversation commands

**Files:**
- Modify: `packages/cli/src/commands/conversations-list.ts`
- Modify: `packages/cli/src/commands/conversations-show.ts`
- Modify: `packages/cli/src/lib/context.ts`

Each currently constructs `FileConversationLogger` directly. Switch to `SqliteConversationLogger`.

Note that these commands also need to call the migration helper if they're the first thing to touch the data dir on a fresh upgrade — but if the user has already run `tap daemon start`, the migration ran during context build, and SQLite is already populated. If the user runs `tap conversations list` before ever starting tapd, the command itself must run the migration.

The cleanest pattern is: every entrypoint that constructs a logger calls `migrateFileLogsToSqlite(dataDir, logger)` once. The migration is idempotent so this is safe.

```ts
// In conversations-list.ts:
import { SqliteConversationLogger, migrateFileLogsToSqlite } from "trusted-agents-core";
// ...
const logger = new SqliteConversationLogger(config.dataDir);
await migrateFileLogsToSqlite(config.dataDir, logger);
const logs = await logger.listConversations();
// ... existing formatting code unchanged
logger.close();
```

Same pattern for `conversations-show.ts` and the `cli/src/lib/context.ts` constructor.

- [ ] **Step 1: Update each file**
- [ ] **Step 2: Run `bun run --cwd packages/cli typecheck`**
- [ ] **Step 3: Run `bun run --cwd packages/cli test`** — most CLI tests should pass; any test that constructed `FileConversationLogger` directly may need updating.
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(cli): conversation commands use SqliteConversationLogger with one-shot migration"
```

---

## Task 7: Verify tapd uses SQLite via default-context

**Files:**
- Verify: `packages/tapd/src/bin.ts` and `daemon.ts`

Tapd already uses `buildDefaultTapRuntimeContext` (Phase 1), which now constructs `SqliteConversationLogger`. No code changes needed — but verify by reading and running the tapd tests.

- [ ] **Step 1: Read `packages/tapd/src/bin.ts` and confirm it uses `buildDefaultTapRuntimeContext`**
- [ ] **Step 2: Run `bun run --cwd packages/tapd test`**
- [ ] **Step 3: Run the http-end-to-end integration test specifically**

```bash
bun run --cwd packages/tapd test test/integration/http-end-to-end.test.ts
```

If the test wires its own conversation logger (likely a fake), no SQLite is involved — that's fine, verify the fake still works against the SqliteConversationLogger interface.

- [ ] **Step 4: Add a test that `Daemon` actually populates the SQLite store**

Add to `packages/tapd/test/integration/http-end-to-end.test.ts` (or a new file):

```ts
it("persists conversations to SQLite when using SqliteConversationLogger", async () => {
  // Construct a Daemon with a real SqliteConversationLogger
  // Insert a message via service mock
  // Query GET /api/conversations and verify the message is present
});
```

This is optional but valuable as a regression gate.

- [ ] **Step 5: Commit (only if tests added)**

```bash
git commit -m "test(tapd): verify SqliteConversationLogger backing for /api/conversations"
```

---

## Task 8: Reflect SQLite in workspace-level smoke

- [ ] **Step 1: Run the full repo test suite**

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: clean. Existing tests using `FileConversationLogger` directly continue to pass against the file-backed implementation; the new SqliteConversationLogger has its own test coverage; `default-context` now uses Sqlite by default and `bun run test` exercises that path indirectly through service tests.

- [ ] **Step 2: Run e2e mock tests**

```bash
bun run --cwd packages/cli test test/e2e/e2e-mock.test.ts
```

Expected: all e2e scenarios pass. The conversation logging happens transparently through `IConversationLogger`, so the scenarios should be untouched by the storage swap.

- [ ] **Step 3: Manual smoke check**

Construct a real tapd against a temp data dir, send a message in via the CLI client (or the in-process tapd helper), and verify `<dataDir>/conversations.db` exists and contains the expected rows. You can use `sqlite3 conversations.db ".dump"` from the command line or write a tiny inspection script.

- [ ] **Step 4: Update Agents.md**

Add a one-line note in `Agents.md` under the `<dataDir>` layout section:

```
├── conversations.db          # SQLite store for conversation logs (replaces conversations/*.json)
├── conversations.bak/        # Pre-migration JSON backups (safe to delete after a release)
```

Remove or update the old `conversations/<id>.json` line.

- [ ] **Step 5: Final commit**

```bash
git commit -m "docs(agents): document SQLite conversation store and backup directory"
```

---

## Task 9: Verification gate

- [ ] **Step 1: Run all tests one more time**

```bash
bun run lint && bun run typecheck && bun run test
```

- [ ] **Step 2: Verify file inventory in `packages/core/src/conversation/`**

```
logger.ts                (FileConversationLogger — kept for back-compat / test fixtures)
sqlite-logger.ts         (SqliteConversationLogger — new default)
sqlite-schema.ts
sqlite-migration.ts
transcript.ts            (unchanged)
types.ts                 (unchanged)
index.ts
```

- [ ] **Step 3: Verify file inventory in `packages/core/test/unit/conversation/`**

```
sqlite-logger.test.ts
sqlite-migration.test.ts
sqlite-schema.test.ts
(plus any existing file-logger tests)
```

- [ ] **Step 4: Confirm `better-sqlite3` is actually being loaded**

`bun run --cwd packages/core test test/unit/conversation/sqlite-logger.test.ts` should pass on a clean checkout. If it fails with native module errors, the prebuilt binary path is wrong — diagnose and fix.

- [ ] **Step 5: Final commit if anything outstanding**

**v2 SQLite conversation store complete.** All conversation data now lives in `<dataDir>/conversations.db`, the legacy JSON files are migrated and backed up, and the rest of the codebase consumes the new store transparently through `IConversationLogger`. The next things on the v2 roadmap (event log unification, channel primitive) are unblocked by this — they can land as follow-up plans without touching the conversation storage code.
